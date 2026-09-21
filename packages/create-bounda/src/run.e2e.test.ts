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
 * packages and the tools into the project's node_modules. The React Router dependencies come
 * from the onboarding example, which already has them installed.
 */
const linkWorkspace = async (
  project: string,
  framework: "node" | "react-router",
): Promise<void> => {
  const modules = join(project, "node_modules");
  const example = join(repoRoot, "examples/onboarding/node_modules");
  await mkdir(join(modules, "@bounda-dev"), { recursive: true });
  await mkdir(join(modules, "@types"), { recursive: true });
  const packages = [
    "core",
    "adapter-sqlite",
    "cli",
    ...(framework === "react-router" ? ["react-router"] : []),
  ];
  for (const name of packages) {
    await symlink(join(repoRoot, "packages", name), join(modules, "@bounda-dev", name));
  }
  await symlink(join(repoRoot, "node_modules/vitest"), join(modules, "vitest"));
  await symlink(join(repoRoot, "node_modules/@types/node"), join(modules, "@types/node"));
  if (framework === "react-router") {
    await mkdir(join(modules, "@react-router"), { recursive: true });
    for (const name of ["react", "react-dom", "react-router", "vite", "isbot"]) {
      await symlink(join(example, name), join(modules, name));
    }
    for (const name of ["dev", "node", "serve"]) {
      await symlink(join(example, "@react-router", name), join(modules, "@react-router", name));
    }
    for (const name of ["react", "react-dom"]) {
      await symlink(join(example, "@types", name), join(modules, "@types", name));
    }
  }
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
    await linkWorkspace(project, "node");

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

  it("scaffolds a React Router app that generates, type-checks, tests and builds", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-bounda-e2e-rr-"));
    temporary.push(cwd);
    const out = { write: () => undefined };
    const code = await runCreate({
      argv: ["web", "--framework", "react-router", "--yes", "--no-git", "--no-install"],
      cwd,
      stdout: out,
      stderr: { write: (text: string) => process.stderr.write(text) },
      templateRoot,
      prompts: null,
    });
    expect(code).toBe(0);
    const project = join(cwd, "web");
    await linkWorkspace(project, "react-router");
    const reactRouter = join(project, "node_modules/@react-router/dev/bin.cjs");

    await run(process.execPath, [join(repoRoot, "packages/cli/dist/cli.js"), "generate"], {
      cwd: project,
    });
    await run(process.execPath, [reactRouter, "typegen"], { cwd: project });
    await run(join(repoRoot, "node_modules/.bin/tsc"), ["--noEmit", "-p", "tsconfig.json"], {
      cwd: project,
    });
    const tested = await run(
      process.execPath,
      [join(repoRoot, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { cwd: project, env: { ...process.env, CI: "1" } },
    );
    expect(`${tested.stdout}${tested.stderr}`).toMatch(/1 passed/);
    const built = await run(process.execPath, [reactRouter, "build"], { cwd: project });
    expect(`${built.stdout}${built.stderr}`).toMatch(/built in/);
  }, 180_000);
});
