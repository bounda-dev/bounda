import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp, silentLogger } from "@bounda-dev/core";
import { loadProject } from "@bounda-dev/core/node";
import { afterAll, describe, expect, it } from "vitest";
import type { registry as fixtureRegistry } from "./fixtures/rebuild-project/.bounda/registry.ts";
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

const watching = (argv: readonly string[], cwd: string, signal: AbortSignal) => {
  const stdout = capture();
  const stderr = capture();
  return { done: runCli({ argv, cwd, stdout, stderr, signal }), stdout, stderr };
};

const until = async (ready: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
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

  it("documents every option of generate in its help", async () => {
    const root = await project();
    const help = await cli(["generate", "--help"], root);
    expect(help.code).toBe(EXIT_OK);
    const flattened = help.stdout.replace(/\s+/g, " ");
    for (const text of [
      "write .bounda/registry.ts, .bounda/types.ts and the +types of every module",
      "--root <dir>",
      "project root (default: current directory)",
      "--app-dir <dir>",
      "application directory under the root",
      '(default: "app")',
      "--tsconfig <file>",
      "tsconfig used to infer state (default: <root>/tsconfig.json)",
      "--no-infer",
      "do not infer state for aggregates without state.ts",
      "--watch",
      "regenerate when a module changes",
    ]) {
      expect(flattened).toContain(text);
    }
    const program = await cli(["--help"], root);
    expect(program.stdout).toContain("Bounda: event sourcing and CQRS for TypeScript");
    expect(program.stdout).toContain("-v, --version");
  });

  it("does not start watching when the first generation fails outright", async () => {
    const root = await project();
    await writeFile(join(root, ".bounda"), "not a directory\n");
    const result = await cli(["generate", "--no-infer", "--watch"], root);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stdout).not.toContain("watching");
  });

  it("reports a failure of a later generation while watching and goes on", async () => {
    const root = await project();
    const controller = new AbortController();
    const { done, stdout, stderr } = watching(
      ["generate", "--no-infer", "--watch"],
      root,
      controller.signal,
    );
    await until(() => stdout.text().includes("watching app/ for changes"), "the watch to start");
    await rm(join(root, ".bounda"), { recursive: true });
    await writeFile(join(root, ".bounda"), "not a directory\n");
    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      "export const apply = () => ({});\n",
    );
    await until(() => stderr.text().includes("error: "), "the failed generation to be reported");
    controller.abort();
    await done;
    expect(stderr.text()).toMatch(/error: /);
    expect(stdout.text()).toContain("watching app/ for changes");
  });

  it("regenerates on changes in --watch mode until aborted", async () => {
    const root = await project();
    const controller = new AbortController();
    const { done, stdout } = watching(
      ["generate", "--no-infer", "--watch"],
      root,
      controller.signal,
    );
    const generated = join(root, "app/domain/order/+types/order-shipped.ts");
    await until(() => stdout.text().includes("watching app/ for changes"), "the watch to start");
    await writeFile(
      join(root, "app/domain/order/order-shipped.ts"),
      'import type { Event } from "./+types/order-shipped";\n\nexport const apply = ({ state }: Event.ApplyArgs) => state;\n',
    );
    await until(
      async () => (await stat(generated).catch(() => null)) !== null,
      "the new event's generated types",
    );
    controller.abort();
    expect(await done).toBe(EXIT_OK);
    expect(stdout.text()).toContain("watching app/ for changes");
    expect(await stat(generated)).toBeTruthy();
  });
});

describe("bounda rebuild", () => {
  const fixture = resolve(import.meta.dirname, "fixtures/rebuild-project");

  it("loads the project, rebuilds the read model and reports what it did", async () => {
    const result = await cli(["rebuild", "counterTotals"], fixture);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      'rebuilt read model "counterTotals": 0 events, checkpoint at position 0\n',
    );
  });

  it("honours --root, --config and --registry", async () => {
    const result = await cli(
      [
        "rebuild",
        "counterTotals",
        "--root",
        fixture,
        "--config",
        "bounda.config.ts",
        "--registry",
        ".bounda/registry.ts",
      ],
      repoRoot,
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toContain('rebuilt read model "counterTotals"');
  });

  it("documents its argument and options in its help", async () => {
    const help = await cli(["rebuild", "--help"], fixture);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain(
      "rebuild a read model from the whole stream into a fresh table and swap it in",
    );
    expect(help.stdout).toContain("<read-model>");
    expect(help.stdout).toContain("the read model's key in the registry, e.g. orderSummary");
    for (const option of ["--root <dir>", "--config <file>", "--registry <file>"]) {
      expect(help.stdout).toContain(option);
    }
    expect(help.stdout).toMatch(/\(default:\s+"bounda\.config\.ts"\)/);
    expect(help.stdout).toMatch(/\(default:\s+"\.bounda\/registry\.ts"\)/);
  });

  it("exits 2 with the reason when the read model or the project is not there", async () => {
    const unknown = await cli(["rebuild", "nope"], fixture);
    expect(unknown.code).toBe(EXIT_FAILURE);
    expect(unknown.stderr).toBe(
      'error: Unknown read model "nope". The registry has: counterTotals\n',
    );
    const missing = await cli(["rebuild", "counterTotals", "--registry", "missing.ts"], fixture);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr).toMatch(/^error: Cannot find the registry \(export "registry"\) at /);
    const noArgument = await cli(["rebuild"], fixture);
    expect(noArgument.code).toBe(EXIT_CONVENTION);
  });
});

describe("bounda dead-letters", () => {
  const fixture = resolve(import.meta.dirname, "fixtures/rebuild-project");

  const deadLetter = async (): Promise<string> => {
    const project = await loadProject<typeof fixtureRegistry>({
      root: fixture,
      logger: silentLogger,
    });
    const app = await createApp({ ...project, logger: silentLogger });
    await app.commands.increment({ counterId: `c-${Date.now()}` });
    await app.processUntilIdle();
    const letters = await app.deadLetters.list();
    await app.stop();
    const id = letters.at(-1)?.id;
    if (id === undefined) throw new Error("the fixture policy did not dead-letter");
    return id;
  };

  it("lists the failed letters of the project, or says there are none", async () => {
    const id = await deadLetter();
    const listed = await cli(["dead-letters", "list"], fixture);
    expect(listed.stderr).toBe("");
    expect(listed.code).toBe(EXIT_OK);
    expect(listed.stdout).toContain(`${id}  failed  policy  counter.alertOnIncremented`);
    expect(listed.stdout).toContain("Incremented on counter:c-");
    expect(listed.stdout).toContain("1 attempt, last 20");
    expect(listed.stdout).toContain("(terminal)\n    alerts are down");
    expect(listed.stdout).toMatch(/\d+ dead letters?\n$/);

    const json = await cli(["dead-letters", "list", "--json", "--kind", "policy"], fixture);
    expect(json.code).toBe(EXIT_OK);
    expect(JSON.parse(json.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, kind: "policy", status: "failed" })]),
    );

    const none = await cli(["dead-letters", "list", "--status", "replayed"], fixture);
    expect(none.code).toBe(EXIT_OK);
    expect(none.stdout).toBe("no dead letters\n");
  });

  it("applies every filter and counts what it prints", async () => {
    await deadLetter();
    await deadLetter();
    const one = await cli(["dead-letters", "list", "--limit", "1"], fixture);
    expect(one.stdout).toMatch(/\n1 dead letter\n$/);
    expect(one.stdout.split("\n").filter((row) => row.includes("  failed  policy  "))).toHaveLength(
      1,
    );
    const two = await cli(["dead-letters", "list", "--limit", "2"], fixture);
    expect(two.stdout).toMatch(/\n2 dead letters\n$/);
    for (const filter of [
      ["--kind", "command"],
      ["--subscriber", "counter.nobody"],
      ["--status", "discarded", "--limit", "0"],
    ]) {
      const result = await cli(["dead-letters", "list", ...filter], fixture);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toBe("no dead letters\n");
    }
    const bySubscriber = await cli(
      [
        "dead-letters",
        "list",
        "--subscriber",
        "counter.alertOnIncremented",
        "--limit",
        "1",
        "--json",
      ],
      fixture,
    );
    expect(JSON.parse(bySubscriber.stdout)).toHaveLength(1);
  });

  it("replays a letter, reporting the handler's error when it fails again, and discards one", async () => {
    const id = await deadLetter();
    const replay = await cli(["dead-letters", "replay", id], fixture);
    expect(replay.code).toBe(EXIT_FAILURE);
    expect(replay.stderr).toBe("error: alerts are down\n");

    const discard = await cli(["dead-letters", "discard", id], fixture);
    expect(discard.stderr).toBe("");
    expect(discard.code).toBe(EXIT_OK);
    expect(discard.stdout).toBe(
      `discarded dead letter ${id}: policy counter.alertOnIncremented for Incremented\n`,
    );

    const again = await cli(["dead-letters", "replay", id], fixture);
    expect(again.code).toBe(EXIT_FAILURE);
    expect(again.stderr).toBe(`error: Dead letter "${id}" was already discarded\n`);
    const missing = await cli(["dead-letters", "discard", "nope"], fixture);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr).toBe('error: Dead letter "nope" not found\n');
  });

  it("documents its subcommands and options in its help", async () => {
    const help = await cli(["dead-letters", "--help"], fixture);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("list, replay or discard the handler runs that gave up");
    for (const sub of ["list", "replay", "discard"]) expect(help.stdout).toContain(sub);
    const list = await cli(["dead-letters", "list", "--help"], fixture);
    for (const option of [
      "--kind <kind>",
      "policy, process or command",
      "--status <status>",
      "failed, replayed or discarded",
      "--subscriber <name>",
      "the policy, process or scheduled command that failed",
      "--limit <n>",
      "at most this many letters",
      "--json",
      "print the letters as JSON",
      "--root <dir>",
      "project root (default: current directory)",
      "configuration module under the root",
      "generated registry module under the root",
    ]) {
      expect(list.stdout).toContain(option);
    }
    expect(list.stdout).toMatch(/--status <status>.*\(default:\s+"failed"\)/s);
    expect(list.stdout).toContain("list dead letters, failed ones by default");
    const replay = await cli(["dead-letters", "replay", "--help"], fixture);
    expect(replay.stdout).toContain(
      "run the failed handler again and mark the letter replayed if it succeeds",
    );
    expect(replay.stdout).toContain("<id>");
    const discard = await cli(["dead-letters", "discard", "--help"], fixture);
    expect(discard.stdout).toContain("mark the letter discarded without running anything");
    expect(discard.stdout).toContain("the dead letter's id");
  });
});
