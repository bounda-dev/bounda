import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

describe("the layer of the copy", () => {
  it("declares, with a description, each secret the Deploy button asks for", async () => {
    const example = await readFile(
      resolve(import.meta.dirname, "../../template/durable-object/_dev.vars.example"),
      "utf8",
    );
    const secrets = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name ?? "");
    expect(secrets).toEqual(["BOUNDA_MASTER_KEY"]);
    const { cloudflare } = (await loadLayer()).package as {
      readonly cloudflare: { readonly bindings: Readonly<Record<string, unknown>> };
    };
    expect(Object.keys(cloudflare.bindings)).toEqual(secrets);
    for (const name of secrets) {
      expect(cloudflare.bindings[name]).toEqual({ description: expect.stringMatching(/\S/) });
    }
  });
});

describe("generate", () => {
  it("builds the template repository from the scaffolder's output and its extras", async () => {
    const { root, project } = await generate({ scaffolder: "workspace", install: false });
    temporary.push(root);
    const manifest = await readManifest(project);
    expect(Object.keys(manifest).slice(0, 2)).toEqual(["name", "description"]);
    expect(manifest.name).toBe("bounda-cloudflare-template");
    expect(manifest.scripts["test:e2e"]).toBe("playwright test");
    expect(manifest.scripts.test).toBe("bounda generate && vitest run");
    expect(manifest.devDependencies["@playwright/test"]).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies.wrangler).toMatch(/^\^/);
    expect(manifest.cloudflare).toMatchObject({
      products: ["Workers", "Durable Objects"],
      bindings: {
        BOUNDA_MASTER_KEY: { description: expect.stringContaining("openssl rand -base64 32") },
      },
    });
    // The deploy flow asks for the secret `.dev.vars.example` names; the scaffolder's key stays out.
    expect(await readFile(join(project, ".dev.vars.example"), "utf8")).toMatch(
      /^BOUNDA_MASTER_KEY=$/m,
    );
    await expect(readFile(join(project, ".dev.vars"), "utf8")).rejects.toThrow();
    expect(await readFile(join(project, "README.md"), "utf8")).toContain(
      "deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template",
    );
    expect(await readFile(join(project, ".gitignore"), "utf8")).toContain("test-results/\n");
    expect(await readFile(join(project, "LICENSE"), "utf8")).toContain("Apache License");
    expect(await readFile(join(project, "e2e/demo.spec.ts"), "utf8")).toContain("Place order");
    expect(await readFile(join(project, "src/worker.ts"), "utf8")).toContain("createBoundaObject");
    expect(await readFile(join(project, "tests/api.test.ts"), "utf8")).toContain("SELF.fetch");
  });
});

describe("loadLayer", () => {
  it("reads the copy's layer", async () => {
    expect(await loadLayer()).toMatchObject({ name: "bounda-cloudflare-template", license: true });
  });
});
