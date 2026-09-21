import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderTemplate, scaffoldProject } from "./scaffold.ts";

const templateRoot = resolve(import.meta.dirname, "../template");
const temporary: string[] = [];
const versions = { bounda: "^0.1.0-alpha.0", typescript: "^7", vitest: "^5", typesNode: "^26" };

const directory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "create-bounda-"));
  temporary.push(root);
  return join(root, "shop");
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("renderTemplate", () => {
  it("replaces every placeholder and rejects unknown ones", () => {
    expect(renderTemplate({ content: "{{a}}-{{b}}-{{a}}", values: { a: "1", b: "2" } })).toBe(
      "1-2-1",
    );
    expect(() => renderTemplate({ content: "{{nope}}", values: {} })).toThrow(
      'template refers to an unknown value "nope"',
    );
  });
});

describe("scaffoldProject", () => {
  it("copies the base and the sqlite overlay, renders templates and renames _gitignore", async () => {
    const target = await directory();
    const report = await scaffoldProject({
      templateRoot,
      options: {
        directory: target,
        name: "shop",
        database: "sqlite",
        packageManager: "pnpm",
        install: true,
        git: true,
      },
      versions,
    });
    expect(report.files).toEqual([
      ".gitignore",
      "README.md",
      "app/domain/order/commands/place-order.ts",
      "app/domain/order/order-placed.ts",
      "app/domain/order/state.ts",
      "app/read/orders/projections/order-placed.ts",
      "app/read/orders/queries/list-orders.ts",
      "app/read/orders/view.ts",
      "bounda.config.ts",
      "package.json",
      "src/main.ts",
      "tests/orders.test.ts",
      "tsconfig.json",
      "vitest.config.ts",
    ]);
    const packageJson = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(packageJson).toMatchObject({
      name: "shop",
      dependencies: {
        "@bounda-dev/core": "^0.1.0-alpha.0",
        "@bounda-dev/adapter-sqlite": "^0.1.0-alpha.0",
      },
      devDependencies: { "@bounda-dev/cli": "^0.1.0-alpha.0", typescript: "^7", vitest: "^5" },
      scripts: { prepare: "bounda generate" },
    });
    expect(await readFile(join(target, "bounda.config.ts"), "utf8")).toContain(
      "@bounda-dev/adapter-sqlite",
    );
    expect(await readFile(join(target, "README.md"), "utf8")).toContain("pnpm install");
    expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(".bounda/");
  });

  it("uses the postgresql overlay when asked", async () => {
    const target = await directory();
    const report = await scaffoldProject({
      templateRoot,
      options: {
        directory: target,
        name: "shop",
        database: "postgresql",
        packageManager: "npm",
        install: true,
        git: true,
      },
      versions,
    });
    expect(report.files).toContain(".env.example");
    expect(await readFile(join(target, ".env.example"), "utf8")).toContain("5432/shop");
    expect(await readFile(join(target, "bounda.config.ts"), "utf8")).toContain(
      "@bounda-dev/adapter-postgresql",
    );
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8")).dependencies).toEqual({
      "@bounda-dev/core": "^0.1.0-alpha.0",
      "@bounda-dev/adapter-postgresql": "^0.1.0-alpha.0",
    });
  });

  it("accepts an empty directory and refuses a non-empty one", async () => {
    const target = await directory();
    await mkdir(target, { recursive: true });
    const options = {
      directory: target,
      name: "shop",
      database: "sqlite" as const,
      packageManager: "pnpm" as const,
      install: true,
      git: true,
    };
    await expect(scaffoldProject({ templateRoot, options, versions })).resolves.toBeTruthy();
    await writeFile(join(target, "extra.txt"), "x");
    await expect(scaffoldProject({ templateRoot, options, versions })).rejects.toThrow(
      /exists and is not empty/,
    );
  });
});
