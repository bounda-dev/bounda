import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Prompts } from "./options.ts";
import { EXIT_FAILURE, EXIT_OK, runCreate } from "./run.ts";
import type { Exec } from "./steps.ts";

const templateRoot = resolve(import.meta.dirname, "../template");
const temporary: string[] = [];

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "create-bounda-run-"));
  temporary.push(root);
  return root;
};

const capture = () => {
  const chunks: string[] = [];
  return { text: () => chunks.join(""), write: (text: string) => void chunks.push(text) };
};

const recorder = () => {
  const calls: string[] = [];
  const exec: Exec = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(" ")} @ ${cwd}`);
  };
  return { calls, exec };
};

const cli = async (
  argv: readonly string[],
  cwd: string,
  options: { readonly exec?: Exec; readonly prompts?: Prompts | null } = {},
) => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCreate({
    argv,
    cwd,
    stdout,
    stderr,
    templateRoot,
    userAgent: "pnpm/12.4.2 npm/? node/v25",
    exec: options.exec ?? recorder().exec,
    prompts: options.prompts ?? null,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("create-bounda", () => {
  it("scaffolds, runs git init and the install, and prints the next steps", async () => {
    const cwd = await workspace();
    const { calls, exec } = recorder();
    const result = await cli(["shop"], cwd, { exec });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("created shop in shop (14 files, sqlite, node)");
    expect(result.stdout).toContain("initialised a git repository");
    expect(result.stdout).toContain("installing dependencies with pnpm");
    expect(result.stdout).toContain("next:\n  cd shop\n  pnpm test\n  pnpm start\n");
    expect(calls).toEqual([
      `git init --quiet @ ${join(cwd, "shop")}`,
      `pnpm install @ ${join(cwd, "shop")}`,
    ]);
    expect((await readdir(join(cwd, "shop"))).sort()).toContain("bounda.config.ts");
  });

  it("skips git and install on request and tells the user to install", async () => {
    const cwd = await workspace();
    const { calls, exec } = recorder();
    const result = await cli(
      ["shop", "--no-git", "--no-install", "--pm", "npm", "--database", "postgresql"],
      cwd,
      { exec },
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("(15 files, postgresql, node)");
    expect(result.stdout).toContain("next:\n  cd shop\n  npm install\n  npm test\n  npm start\n");
    expect(calls).toEqual([]);
  });

  it("tells a Cloudflare project to run dev, which is where wrangler starts", async () => {
    const cwd = await workspace();
    const { calls, exec } = recorder();
    const result = await cli(
      ["edge", "--no-git", "--no-install", "--pm", "npm", "--framework", "cloudflare"],
      cwd,
      { exec },
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("(16 files, cloudflare, cloudflare)");
    expect(result.stdout).toContain("next:\n  cd edge\n  npm install\n  npm test\n  npm run dev\n");
    expect(calls).toEqual([]);
  });

  it("warns and goes on when git or the install fail", async () => {
    const cwd = await workspace();
    const failing: Exec = async (command) => {
      throw new Error(`${command} exploded`);
    };
    const result = await cli(["shop", "--pm", "yarn"], cwd, { exec: failing });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toContain("warning: git init failed (git exploded)");
    expect(result.stderr).toContain("warning: install failed (yarn exploded); run yarn yourself");
  });

  it("asks through the prompts and honours a cancel", async () => {
    const cwd = await workspace();
    const prompts: Prompts = {
      text: async () => "asked-shop",
      select: async (message) => (message.startsWith("How") ? "node" : "sqlite") as never,
    };
    const result = await cli(["--no-git", "--no-install"], cwd, { prompts });
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("created asked-shop in asked-shop");

    const cancelled = await cli(["--no-git", "--no-install"], cwd, {
      prompts: { text: async () => null, select: async () => null },
    });
    expect(cancelled.code).toBe(EXIT_FAILURE);
    expect(cancelled.stderr).toBe("cancelled\n");
  });

  it("uses the defaults with --yes and refuses a non-empty directory", async () => {
    const cwd = await workspace();
    const first = await cli(["--yes", "--no-git", "--no-install"], cwd);
    expect(first.code).toBe(EXIT_OK);
    expect(first.stdout).toContain("created bounda-app in bounda-app (14 files, sqlite, node)");
    const again = await cli(["bounda-app", "--yes", "--no-git", "--no-install"], cwd);
    expect(again.code).toBe(EXIT_FAILURE);
    expect(again.stderr).toMatch(/^error: .*bounda-app exists and is not empty\n$/);
  });

  it("spells the next steps for the package manager that ran it", async () => {
    const cwd = await workspace();
    const { exec } = recorder();
    const bun = await cli(["shop", "--pm", "bun", "--no-git"], cwd, { exec });
    expect(bun.stdout).toContain("installing dependencies with bun");
    expect(bun.stdout).not.toContain("initialised a git repository");
    expect(bun.stdout).toContain("next:\n  cd shop\n  bun run test\n  bun run start\n");
    const stdout = capture();
    const stderr = capture();
    await runCreate({
      argv: ["other", "--no-git", "--no-install"],
      cwd,
      stdout,
      stderr,
      templateRoot,
      userAgent: "yarn/4.9.1 npm/? node/v24",
      exec,
      prompts: null,
    });
    expect(stdout.text()).toContain("next:\n  cd other\n  yarn\n  yarn test\n  yarn start\n");
    expect(stderr.text()).toBe("");
  });

  it("scaffolds a React Router app and points at the dev server", async () => {
    const cwd = await workspace();
    const result = await cli(
      ["web", "--framework", "react-router", "--no-git", "--no-install"],
      cwd,
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("created web in web (22 files, sqlite, react-router)");
    expect(result.stdout).toContain("next:\n  cd web\n  pnpm install\n  pnpm test\n  pnpm dev\n");
    expect(await readdir(join(cwd, "web", "app", "routes"))).toEqual(["home.tsx"]);
  });

  it("rejects bad flag values and prints help", async () => {
    const cwd = await workspace();
    const bad = await cli(["shop", "--database", "mongo", "--no-git", "--no-install"], cwd);
    expect(bad.code).toBe(EXIT_FAILURE);
    expect(bad.stderr).toContain("--database must be one of sqlite, postgresql");
    const help = await cli(["--help"], cwd);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("--database <name>");
    expect(help.stdout).toContain("--framework <name>");
    const framework = await cli(["shop", "--framework", "next", "--no-git", "--no-install"], cwd);
    expect(framework.code).toBe(EXIT_FAILURE);
    expect(framework.stderr).toContain("--framework must be one of node, react-router");
  });
});
