import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate, loadLayer } from "./sync.ts";

const temporary: string[] = [];

afterAll(async () => {
  await Promise.all(temporary.map((path) => rm(path, { recursive: true, force: true })));
});

const readManifest = async (path: string) =>
  JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
    readonly name: string;
    readonly description: string;
    readonly scripts: Readonly<Record<string, string>>;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly devDependencies: Readonly<Record<string, string>>;
    readonly cloudflare: Readonly<Record<string, unknown>>;
  };

const templatesRepository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-templates-repo-"));
  temporary.push(root);
  const template = async (name: string, devDependencies: Record<string, string>) => {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(join(root, name, "package.json"), JSON.stringify({ name, devDependencies }));
  };
  await template("d1-template", { typescript: "5.9.3", wrangler: "4.136.1" });
  await template("chanfana-openapi-template", { vitest: "4.1.10", wrangler: "4.136.1" });
  await template("voice-agent-template", { "@cloudflare/vitest-plugin": "1.1.3" });
  await template("bounda-event-sourcing-template", { vitest: "0.0.1" });
  await mkdir(join(root, "cli/src"), { recursive: true });
  await writeFile(
    join(root, "cli/src/lint.ts"),
    'const TARGET_COMPATIBILITY_DATE = "2025-10-08";\n',
  );
  await writeFile(
    join(root, ".syncpackrc.json"),
    JSON.stringify({
      versionGroups: [
        {
          packages: ["bounda-event-sourcing-template"],
          dependencies: ["typescript"],
          pinVersion: "7.0.2",
        },
      ],
    }),
  );
  return root;
};

describe("generate", () => {
  it("builds the template repository from the scaffolder's output and its extras", async () => {
    const { root, project } = await generate({
      target: "bounda-cloudflare-template",
      scaffolder: "workspace",
      install: false,
    });
    temporary.push(root);
    const manifest = await readManifest(project);
    expect(Object.keys(manifest).slice(0, 2)).toEqual(["name", "description"]);
    expect(manifest.name).toBe("bounda-cloudflare-template");
    expect(manifest.scripts["test:e2e"]).toBe("playwright test");
    expect(manifest.scripts.test).toBe("bounda generate && vitest run");
    expect(manifest.devDependencies["@playwright/test"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies.wrangler).toMatch(/^\^/);
    expect(manifest.cloudflare).toMatchObject({ products: ["Workers", "Durable Objects"] });
    expect(await readFile(join(project, "README.md"), "utf8")).toContain(
      "deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template",
    );
    expect(await readFile(join(project, ".gitignore"), "utf8")).toContain("test-results/\n");
    expect(await readFile(join(project, "LICENSE"), "utf8")).toContain("Apache License");
    expect(await readFile(join(project, "e2e/demo.spec.ts"), "utf8")).toContain("Place order");
    expect(await readFile(join(project, "src/worker.ts"), "utf8")).toContain("createBoundaObject");
    expect(await readFile(join(project, "tests/api.test.ts"), "utf8")).toContain("SELF.fetch");
  });

  it("builds the cloudflare/templates directory with the repository's versions and date", async () => {
    const repository = await templatesRepository();
    const { root, project, layer } = await generate({
      target: "cloudflare-templates",
      scaffolder: "workspace",
      repository,
      install: false,
    });
    temporary.push(root);
    expect(project).toBe(join(root, layer.name));
    const manifest = await readManifest(project);
    expect(manifest.name).toBe("bounda-event-sourcing-template");
    expect(manifest.devDependencies).toMatchObject({
      typescript: "7.0.2",
      vitest: "4.1.10",
      wrangler: "4.136.1",
      "@cloudflare/vitest-plugin": "1.1.3",
    });
    expect(manifest.dependencies["@bounda-dev/core"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.cloudflare).toMatchObject({ label: "Event Sourcing with Bounda" });
    expect(await readFile(join(project, "wrangler.jsonc"), "utf8")).toContain(
      '"compatibility_date": "2025-10-08"',
    );
    expect(await readFile(join(project, ".gitignore"), "utf8")).toContain("### Bounda ###");
    expect(
      await readFile(join(root, "playwright-tests/bounda-event-sourcing-template.spec.ts"), "utf8"),
    ).toContain("Event-sourced orders");
  });

  it("refuses to align the cloudflare/templates copy without a clone of that repository", async () => {
    await expect(
      generate({ target: "cloudflare-templates", scaffolder: "workspace", install: false }),
    ).rejects.toThrow("cloudflare-templates needs a clone of its repository");
  });
});

describe("loadLayer", () => {
  it("reads each copy's layer", async () => {
    expect(await loadLayer("bounda-cloudflare-template")).toMatchObject({
      layout: "project",
      pin: "range",
      license: true,
    });
    expect(await loadLayer("cloudflare-templates")).toMatchObject({
      name: "bounda-event-sourcing-template",
      layout: "monorepo",
      pin: "aligned",
    });
  });
});
