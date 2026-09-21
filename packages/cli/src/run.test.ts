import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT_CONVENTION, EXIT_FAILURE, EXIT_OK, runCli } from "./run.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureRoot = join(repoRoot, "packages/core/test-types/fixtures/order-app-inferred");
const temporary: string[] = [];

const project = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "bounda-cli-"));
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
        paths: { "@bounda-dev/core": [join(repoRoot, "packages/core/src/index.ts")] },
      },
      include: ["."],
    }),
  );
  return root;
};

const capture = () => {
  const chunks: string[] = [];
  return { text: () => chunks.join(""), write: (text: string) => void chunks.push(text) };
};

const cli = async (argv: readonly string[], cwd: string, signal?: AbortSignal) => {
  const stdout = capture();
  const stderr = capture();
  const code = await runCli({
    argv,
    cwd,
    stdout,
    stderr,
    ...(signal === undefined ? {} : { signal }),
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
};

afterAll(async () => {
  await Promise.all(temporary.map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounda generate", () => {
  it("generates a project, reports the files and the inference warnings, and exits 0", async () => {
    const root = await project();
    const first = await cli(["generate"], root);
    expect(first.code).toBe(EXIT_OK);
    expect(first.stderr).toMatch(/^warning: order: field "cancellation" .* typed as unknown\./m);
    expect(first.stdout).toContain("  written  .bounda/registry.ts");
    expect(first.stdout).toContain("  written  app/domain/order/+types/order-placed.ts");
    expect(first.stdout).toMatch(
      /1 aggregate, 0 read models, 8 files \(8 written, 0 unchanged, 0 removed\)$/m,
    );

    const second = await cli(["generate", "--root", root], repoRoot);
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toBe(
      "1 aggregate, 0 read models, 8 files (0 written, 8 unchanged, 0 removed)\n",
    );
  });

  it("skips inference with --no-infer and honours --app-dir and --tsconfig", async () => {
    const root = await project();
    await cp(join(root, "app"), join(root, "src"), { recursive: true });
    await rm(join(root, "app"), { recursive: true });
    const result = await cli(
      ["generate", "--no-infer", "--app-dir", "src", "--tsconfig", "tsconfig.json"],
      root,
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe("");
    expect(await readFile(join(root, ".bounda/types.ts"), "utf8")).toContain(
      "export type OrderState = core.UnknownState;",
    );
    expect(await stat(join(root, "src/domain/order/+types/order-paid.ts"))).toBeTruthy();
  });

  it("exits 1 and lists every problem when the layout breaks a convention", async () => {
    const root = await project();
    await mkdir(join(root, "app/domain/order/helpers"));
    await writeFile(join(root, "app/domain/order/Order_Shipped.ts"), "export {};\n");
    const result = await cli(["generate"], root);
    expect(result.code).toBe(EXIT_CONVENTION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "error: 2 problems in the project layout",
        "  app/domain/order/Order_Shipped.ts: Event names must be kebab-case (lower-case letters, digits and dashes)",
        "  app/domain/order/helpers: an aggregate holds events, state.ts and the directories commands, policies and processes",
        "",
      ].join("\n"),
    );
  });

  it("exits 2 on unexpected failures", async () => {
    const root = await project();
    await writeFile(join(root, ".bounda"), "not a directory\n");
    const result = await cli(["generate", "--no-infer"], root);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^error: /);
  });

  it("prints help and version without running anything", async () => {
    const root = await project();
    const help = await cli(["--help"], root);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("generate");
    const version = await cli(["--version"], root);
    expect(version.code).toBe(EXIT_OK);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const unknown = await cli(["frobnicate"], root);
    expect(unknown.code).toBe(EXIT_CONVENTION);
  });

  it("regenerates on changes in --watch mode until aborted", async () => {
    const root = await project();
    const controller = new AbortController();
    const running = cli(["generate", "--no-infer", "--watch"], root, controller.signal);
    const generated = join(root, "app/domain/order/+types/order-shipped.ts");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      'import type { Event } from "./+types/order-shipped";\n\nexport const apply = ({ state }: Event.ApplyArgs) => state;\n',
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await stat(generated).catch(() => null)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort();
    const result = await running;
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain("watching app/ for changes");
    expect(await stat(generated)).toBeTruthy();
  });
});
