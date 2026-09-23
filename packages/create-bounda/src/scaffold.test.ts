import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { renderTemplate, scaffoldProject } from "./scaffold.ts";

const templateRoot = resolve(import.meta.dirname, "../template");
const temporary: string[] = [];
const versions = {
  bounda: "^0.1.0-alpha.0",
  typescript: "^7",
  vitest: "^5",
  typesNode: "^26",
  react: "^19",
  reactRouter: "^8",
  vite: "^8",
  isbot: "^5",
  typesReact: "^19",
  wrangler: "^4",
  cloudflareVitest: "^4.1",
  cloudflareVitestPlugin: "^1.2",
};

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
        framework: "node",
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
        framework: "node",
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

  it("lays the react-router overlay over the base and the database", async () => {
    const target = await directory();
    const report = await scaffoldProject({
      templateRoot,
      options: {
        directory: target,
        name: "shop",
        database: "sqlite",
        framework: "react-router",
        packageManager: "pnpm",
        install: true,
        git: true,
      },
      versions,
    });
    expect(report.files).toEqual([
      ".gitignore",
      "README.md",
      "app/app.css",
      "app/domain/order/commands/place-order.ts",
      "app/domain/order/order-placed.ts",
      "app/domain/order/state.ts",
      "app/errors.server.ts",
      "app/read/orders/projections/order-placed.ts",
      "app/read/orders/queries/list-orders.ts",
      "app/read/orders/view.ts",
      "app/root.tsx",
      "app/routes.ts",
      "app/routes/home.tsx",
      "bounda.config.ts",
      "package.json",
      "public/favicon.ico",
      "public/favicon.svg",
      "react-router.config.ts",
      "tests/orders.test.ts",
      "tsconfig.json",
      "vite.config.ts",
      "vitest.config.ts",
    ]);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.scripts.dev).toBe("react-router dev");
    expect(manifest.scripts.typecheck).toBe(
      "react-router typegen && tsc --noEmit -p tsconfig.json",
    );
    expect(manifest.dependencies).toMatchObject({
      "@bounda-dev/react-router": "^0.1.0-alpha.0",
      "@bounda-dev/adapter-sqlite": "^0.1.0-alpha.0",
      "react-router": "^8",
      react: "^19",
      isbot: "^5",
    });
    expect(manifest.devDependencies).toMatchObject({
      "@react-router/dev": "^8",
      "@types/react": "^19",
      vite: "^8",
    });
    expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(".react-router/");
    expect(await readFile(join(target, "README.md"), "utf8")).toContain("pnpm run dev");
  });

  it("lays the cloudflare overlay over the base alone, with its own storage", async () => {
    const target = await directory();
    const report = await scaffoldProject({
      templateRoot,
      options: {
        directory: target,
        name: "edge",
        database: "cloudflare",
        framework: "cloudflare",
        packageManager: "npm",
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
      "public/index.html",
      "src/worker.ts",
      "tests/api.test.ts",
      "tests/orders.test.ts",
      "tsconfig.json",
      "vitest.config.ts",
      "wrangler.jsonc",
    ]);
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(manifest.scripts).toMatchObject({
      generate: "bounda generate && wrangler types",
      build: "bounda generate",
      dev: "bounda generate && wrangler types && wrangler dev",
      deploy: "bounda generate && wrangler deploy",
      test: "bounda generate && vitest run",
    });
    expect(manifest.scripts).not.toHaveProperty("prepare");
    expect(manifest.dependencies).toEqual({
      "@bounda-dev/adapter-cloudflare": "^0.1.0-alpha.0",
      "@bounda-dev/core": "^0.1.0-alpha.0",
    });
    expect(manifest.devDependencies).toEqual({
      "@bounda-dev/cli": "^0.1.0-alpha.0",
      "@cloudflare/vitest-plugin": "^1.2",
      typescript: "^7",
      vitest: "^4.1",
      wrangler: "^4",
    });
    expect(await readFile(join(target, "vitest.config.ts"), "utf8")).toContain("cloudflareTest");
    expect(await readFile(join(target, "bounda.config.ts"), "utf8")).toContain("cloudflare()");
    expect(await readFile(join(target, "wrangler.jsonc"), "utf8")).toContain('"name": "edge"');
    expect(await readFile(join(target, "wrangler.jsonc"), "utf8")).toContain(
      '"assets": { "directory": "./public" }',
    );
    expect(await readFile(join(target, "wrangler.jsonc"), "utf8")).toContain(
      '"upload_source_maps": true',
    );
    expect(await readFile(join(target, ".gitignore"), "utf8")).toContain(".wrangler/");
    expect(await readFile(join(target, "README.md"), "utf8")).toContain("npm run deploy");
  });

  it("accepts an empty directory and refuses a non-empty one", async () => {
    const target = await directory();
    await mkdir(target, { recursive: true });
    const options = {
      directory: target,
      name: "shop",
      database: "sqlite" as const,
      framework: "node" as const,
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
