import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runCreate } from "./run.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const templateRoot = resolve(import.meta.dirname, "../template");
const run = promisify(execFile);
const temporary: string[] = [];

/**
 * Stands in for `npm install` while the packages are not published: links the workspace
 * packages and the tools into the project's node_modules.
 */
const linkWorkspace = async (project: string): Promise<void> => {
  const modules = join(project, "node_modules");
  await mkdir(join(modules, "@bounda-dev"), { recursive: true });
  for (const name of ["core", "adapter-sqlite", "cli"]) {
    await symlink(join(repoRoot, "packages", name), join(modules, "@bounda-dev", name));
  }
  await symlink(join(repoRoot, "node_modules/vitest"), join(modules, "vitest"));
  await mkdir(join(modules, "@types"), { recursive: true });
  await symlink(join(repoRoot, "node_modules/@types/node"), join(modules, "@types/node"));
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("a project created by create-bounda", () => {
  it("generates, type-checks and passes its own test", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-bounda-e2e-"));
    temporary.push(cwd);
    const out = { write: () => undefined };
    const code = await runCreate({
      argv: ["shop", "--yes", "--no-git", "--no-install"],
      cwd,
      stdout: out,
      stderr: { write: (text: string) => process.stderr.write(text) },
      templateRoot,
      prompts: null,
    });
    expect(code).toBe(0);
    const project = join(cwd, "shop");
    await linkWorkspace(project);

    const generated = await run(
      process.execPath,
      [join(repoRoot, "packages/cli/dist/cli.js"), "generate"],
      {
        cwd: project,
      },
    );
    expect(generated.stdout).toMatch(/1 aggregate, 1 read model, \d+ files/);

    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });

    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/1 passed/);
  }, 120_000);
});
