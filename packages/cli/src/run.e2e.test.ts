import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const temporary: string[] = [];
const run = promisify(execFile);

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-cli-e2e-"));
  temporary.push(root);
  await cp(join(fixtureRoot, "app"), join(root, "app"), {
    recursive: true,
    filter: (source) => !source.includes("/+types"),
  });
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({
      extends: join(repoRoot, "tsconfig.base.json"),
      compilerOptions: {
        isolatedDeclarations: false,
        declaration: false,
        types: [],
        paths: {
          "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")],
          "@bounda-dev/core/register": [join(repoRoot, "packages/core/src/register/index.ts")],
        },
      },
      include: [".", ".bounda/**/*"],
    }),
  );
  return root;
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounda binary end to end", () => {
  it("runs from source and the generated project type-checks", async () => {
    const root = await project();
    const node = process.execPath;
    const { stdout } = await run(node, [join(repoRoot, "packages/cli/src/cli.ts"), "generate"], {
      cwd: root,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(stdout).toContain("8 files (8 written");
    await run(
      join(repoRoot, "node_modules/.bin/tsc"),
      ["--noEmit", "-p", join(root, "tsconfig.json")],
      {
        cwd: root,
      },
    );
  }, 60_000);
});
