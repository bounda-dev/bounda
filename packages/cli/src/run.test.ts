import { writeFileSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createApp, silentLogger } from "@bounda-dev/core";
import { loadProject } from "@bounda-dev/core/node";
import { afterAll, describe, expect, it, vi } from "vitest";
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
    filter: (source) => basename(source) !== "+types",
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

const capture = (onWrite: (text: string) => void = () => undefined) => {
  const chunks: string[] = [];
  return {
    text: () => chunks.join(""),
    write: (text: string) => {
      chunks.push(text);
      onWrite(text);
    },
  };
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

// What a command wrote to standard error besides the app's log lines.
const besidesLogs = (stderr: string): string =>
  stderr
    .split("\n")
    .filter((row) => !row.startsWith("[bounda] "))
    .join("\n");

// The fields of each log line with this message, parsed.
const logged = (stderr: string, level: string, message: string): unknown[] => {
  const prefix = `[bounda] ${level} ${message} `;
  return stderr
    .split("\n")
    .filter((row) => row.startsWith(prefix))
    .map((row) => JSON.parse(row.slice(prefix.length)));
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
      /1 aggregate, 0 read models, 9 files \(9 written, 0 unchanged, 0 removed\)$/m,
    );

    const second = await cli(["generate", "--root", root], repoRoot);
    expect(second.code).toBe(EXIT_OK);
    expect(second.stdout).toBe(
      "1 aggregate, 0 read models, 9 files (0 written, 9 unchanged, 0 removed)\n",
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
    await mkdir(join(root, "app/domain/order/infrastructure/helpers"), { recursive: true });
    await writeFile(
      join(root, "app/domain/order/Order_Shipped.ts"),
      "export const evolve = () => ({});\n",
    );
    const result = await cli(["generate"], root);
    expect(result.code).toBe(EXIT_CONVENTION);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      [
        "error: 2 problems in the project layout",
        "  app/domain/order/Order_Shipped.ts: Event names must be kebab-case (lower-case letters, digits and dashes)",
        "  app/domain/order/infrastructure/helpers: has no port: add helpers.ts at the aggregate root exporting interface Helpers",
        "",
      ].join("\n"),
    );
  });

  it("warns about a layout that is probably wrong, and exits 0", async () => {
    const root = await project();
    await mkdir(join(root, "app/domain/order/command"));
    await writeFile(join(root, "app/domain/order/command/place-order.ts"), "export {};\n");
    const result = await cli(["generate", "--no-infer"], root);
    expect(result.code).toBe(EXIT_OK);
    expect(result.stderr).toBe(
      "warning: order: app/domain/order/command: the generator does not read this directory; rename it to commands if that is what it holds\n",
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

  it("exits without watching when the first generation fails outright", async () => {
    const root = await project();
    await writeFile(join(root, ".bounda"), "not a directory\n");
    const result = await cli(["generate", "--no-infer", "--watch"], root);
    expect(result.code).toBe(EXIT_FAILURE);
    expect(result.stderr).toMatch(/^error: .*\.bounda/);
    expect(result.stdout).not.toContain("watching");
  });

  it("reports a missing application directory in watch mode without crashing", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-cli-"));
    temporary.push(root);
    const controller = new AbortController();
    const stderr = capture();
    const stdout = capture();
    const running = runCli({
      argv: ["generate", "--no-infer", "--watch"],
      cwd: root,
      stdout,
      stderr,
      signal: controller.signal,
    });
    await vi.waitFor(
      () => expect(stderr.text()).toContain("the application directory does not exist"),
      { timeout: 5_000 },
    );
    controller.abort();
    expect(await running).not.toBe(EXIT_OK);
    expect(stdout.text()).not.toContain("watching");
  }, 15_000);

  it("listens for SIGINT and SIGTERM only while a watch runs, and stops it on one", async () => {
    const root = await project();
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    expect((await cli(["generate", "--no-infer"], root)).code).toBe(EXIT_OK);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);

    const stderr = capture();
    const running = runCli({
      argv: ["generate", "--no-infer", "--watch"],
      cwd: root,
      stdout: capture(),
      stderr,
    });
    await vi.waitFor(() => expect(stderr.text()).toContain("watching app/ for changes"), {
      timeout: 5_000,
    });
    expect(process.listenerCount("SIGINT")).toBe((before[0] ?? 0) + 1);
    process.emit("SIGINT", "SIGINT");
    expect(await running).toBe(EXIT_OK);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  }, 15_000);

  it("reports a failure of a later generation while watching and goes on", async () => {
    const root = await project();
    const controller = new AbortController();
    const stdout = capture();
    const stderr = capture();
    const running = runCli({
      argv: ["generate", "--no-infer", "--watch"],
      cwd: root,
      stdout,
      stderr,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(stderr.text()).toContain("watching app/ for changes"), {
      timeout: 5_000,
    });
    const registry = join(root, ".bounda/registry.ts");
    await chmod(registry, 0o444);
    try {
      await writeFile(
        join(root, "app/domain/order/order-shipped.ts"),
        "export const evolve = () => ({});\n",
      );
      await vi.waitFor(
        () => expect(stderr.text()).toMatch(/^error: .*\.bounda[\\/]registry\.ts/m),
        {
          timeout: 5_000,
        },
      );
    } finally {
      await chmod(registry, 0o644);
    }
    await writeFile(
      join(root, "app/domain/order/order-returned.ts"),
      "export const evolve = () => ({});\n",
    );
    await vi.waitFor(() => stat(join(root, "app/domain/order/+types/order-returned.ts")), {
      timeout: 5_000,
    });
    controller.abort();
    await running;
  }, 20_000);

  it("regenerates a module saved while the first generation is running, until aborted", async () => {
    const root = await project();
    const controller = new AbortController();
    let saved = false;
    const stdout = capture(() => {
      if (saved) return;
      saved = true;
      writeFileSync(
        join(root, "app/domain/order/order-shipped.ts"),
        'import type { Event } from "./+types/order-shipped";\n\nexport const evolve = ({ state }: Event.EvolveArgs) => state;\n',
      );
    });
    const running = runCli({
      argv: ["generate", "--no-infer", "--watch"],
      cwd: root,
      stdout,
      stderr: capture(),
      signal: controller.signal,
    });
    await vi.waitFor(() => stat(join(root, "app/domain/order/+types/order-shipped.ts")), {
      timeout: 5_000,
    });
    controller.abort();
    expect(await running).toBe(EXIT_OK);
  }, 15_000);
});

describe("bounda rebuild", () => {
  const fixture = resolve(import.meta.dirname, "fixtures/rebuild-project");

  it("loads the project, rebuilds the read model and reports what it did", async () => {
    const result = await cli(["rebuild", "counterTotals"], fixture);
    expect(besidesLogs(result.stderr)).toBe("");
    expect(result.stderr).toContain(
      '[bounda] info read model rebuilt {"readModel":"counterTotals","events":0,"position":0}',
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.stdout).toBe(
      'rebuilt read model "counterTotals": 0 events, checkpoint at position 0\n',
    );
  });

  it("names who runs it with --actor, and refuses an actor as would", async () => {
    const result = await cli(["rebuild", "counterTotals", "--actor", "operator-1"], fixture);
    expect(result.code).toBe(EXIT_OK);
    expect(logged(result.stderr, "info", "read model rebuilt")).toEqual([
      { readModel: "counterTotals", events: 0, position: 0, actor: "operator-1" },
    ]);
    for (const actor of ["", "x".repeat(256)]) {
      const refused = await cli(["rebuild", "counterTotals", "--actor", actor], fixture);
      expect(refused.code).toBe(EXIT_CONVENTION);
      expect(refused.stderr).toContain("expected the id of who acts, of 1 to 255 characters");
    }
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
    expect(help.stdout.replace(/\s+/g, " ")).toContain(
      "--actor <id> the id of who runs the command, named in the events it writes, its log lines and the access log",
    );
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
    await app.runUntilIdle();
    const letters = await app.deadLetters.list();
    await app.stop();
    const id = letters.at(-1)?.id;
    if (id === undefined) throw new Error("the fixture policy did not dead-letter");
    return id;
  };

  it("lists the failed letters of the project, or says there are none", async () => {
    const id = await deadLetter();
    const listed = await cli(["dead-letters", "list"], fixture);
    expect(besidesLogs(listed.stderr)).toBe("");
    expect(listed.code).toBe(EXIT_OK);
    expect(listed.stdout).toContain(`${id}  failed  policy  counter.alertOnIncremented`);
    expect(listed.stdout).toContain("Incremented on counter:c-");
    expect(listed.stdout).toContain("1 attempt, last 20");
    expect(listed.stdout).toContain(
      "(terminal)\n    ValidationError (VALIDATION_FAILED): alerts are down",
    );
    expect(listed.stdout).toMatch(/\d+ dead letters?\n$/);

    const json = await cli(["dead-letters", "list", "--json", "--kind", "policy"], fixture);
    expect(json.code).toBe(EXIT_OK);
    expect(JSON.parse(json.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, kind: "policy", status: "failed" })]),
    );

    const none = await cli(["dead-letters", "list", "--status", "retried"], fixture);
    expect(none.code).toBe(EXIT_OK);
    expect(none.stdout).toBe("no dead letters\n");
  });

  it("prints the letters alone on standard output, so --json parses while the app logs on standard error", async () => {
    const id = await deadLetter();
    const json = await cli(["dead-letters", "list", "--json"], fixture);
    expect(json.code).toBe(EXIT_OK);
    expect(JSON.parse(json.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, kind: "policy" })]),
    );
    expect(json.stderr).toContain("[bounda] info bounda app created");
    expect(logged(json.stderr, "info", "personal data accessed")).toEqual([
      expect.objectContaining({ operation: "deadLetters.list", actor: null }),
    ]);

    const acting = await cli(["dead-letters", "list", "--json", "--actor", "operator-1"], fixture);
    expect(JSON.parse(acting.stdout)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id })]),
    );
    expect(logged(acting.stderr, "info", "personal data accessed")).toEqual([
      expect.objectContaining({ operation: "deadLetters.list", actor: "operator-1" }),
    ]);
  });

  it("names who retries or discards a letter with --actor, in the log and the access log", async () => {
    const id = await deadLetter();
    const retry = await cli(["dead-letters", "retry", id, "--actor", "operator-1"], fixture);
    expect(retry.code).toBe(EXIT_FAILURE);
    expect(logged(retry.stderr, "info", "personal data accessed")).toEqual([
      expect.objectContaining({ operation: "deadLetters.retry", actor: "operator-1" }),
    ]);
    const discard = await cli(["dead-letters", "discard", id, "--actor", "operator-2"], fixture);
    expect(discard.code).toBe(EXIT_OK);
    expect(logged(discard.stderr, "info", "personal data accessed")).toEqual([
      expect.objectContaining({ operation: "deadLetters.discard", actor: "operator-2" }),
    ]);
    expect(logged(discard.stderr, "info", "dead letter discarded")).toEqual([
      expect.objectContaining({ id, actor: "operator-2" }),
    ]);
    const refused = await cli(["dead-letters", "list", "--actor", ""], fixture);
    expect(refused.code).toBe(EXIT_CONVENTION);
    expect(refused.stderr).toContain("expected the id of who acts");
  });

  it("takes only a whole number of letters, 0 or more, as the limit", async () => {
    for (const limit of ["abc", "-1", "2.5", ""]) {
      const refused = await cli(["dead-letters", "list", "--limit", limit], fixture);
      expect(refused.code).toBe(EXIT_CONVENTION);
      expect(refused.stderr).toContain("expected a whole number of letters, 0 or more");
    }
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
      ["--kind", "scheduled"],
      ["--handler", "counter.nobody"],
      ["--status", "discarded", "--limit", "0"],
    ]) {
      const result = await cli(["dead-letters", "list", ...filter], fixture);
      expect(result.code).toBe(EXIT_OK);
      expect(result.stdout).toBe("no dead letters\n");
    }
    const byHandler = await cli(
      ["dead-letters", "list", "--handler", "counter.alertOnIncremented", "--limit", "1", "--json"],
      fixture,
    );
    expect(JSON.parse(byHandler.stdout)).toHaveLength(1);
    for (const filter of [
      ["--kind", "command"],
      ["--status", "replayed"],
    ]) {
      const result = await cli(["dead-letters", "list", ...filter], fixture);
      expect(result.code).toBe(EXIT_CONVENTION);
      expect(result.stderr).toContain("is invalid. Allowed choices are");
    }
  });

  it("retries a letter, reporting the handler's error when it fails again, and discards one", async () => {
    const id = await deadLetter();
    const retry = await cli(["dead-letters", "retry", id], fixture);
    expect(retry.code).toBe(EXIT_FAILURE);
    expect(besidesLogs(retry.stderr)).toBe("error: alerts are down\n");

    const discard = await cli(["dead-letters", "discard", id], fixture);
    expect(besidesLogs(discard.stderr)).toBe("");
    expect(discard.code).toBe(EXIT_OK);
    expect(discard.stdout).toBe(
      `discarded dead letter ${id}: policy counter.alertOnIncremented for Incremented\n`,
    );

    const again = await cli(["dead-letters", "retry", id], fixture);
    expect(again.code).toBe(EXIT_FAILURE);
    expect(besidesLogs(again.stderr)).toBe(`error: Dead letter "${id}" was already discarded\n`);
    const missing = await cli(["dead-letters", "discard", "nope"], fixture);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(besidesLogs(missing.stderr)).toBe('error: Dead letter "nope" not found\n');
  });

  it("documents its subcommands and options in its help", async () => {
    const help = await cli(["dead-letters", "--help"], fixture);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("list, retry or discard the handler runs that gave up");
    for (const sub of ["list", "retry", "discard"]) expect(help.stdout).toContain(sub);
    const list = await cli(["dead-letters", "list", "--help"], fixture);
    for (const option of [
      "--kind <kind>",
      "only letters of this kind",
      "--status <status>",
      "only letters in this status",
      "--handler <name>",
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
    expect(list.stdout).toMatch(
      /--kind <kind>.*\(choices:\s+"policy",\s+"process",\s+"scheduled"\)/s,
    );
    expect(list.stdout).toMatch(
      /--status <status>.*\(choices:\s+"failed",\s+"retried",\s+"discarded",\s+default:\s+"failed"\)/s,
    );
    expect(list.stdout).toContain("list dead letters, failed ones by default");
    expect(list.stdout).toContain("--actor <id>");
    const retry = await cli(["dead-letters", "retry", "--help"], fixture);
    expect(retry.stdout).toContain(
      "run the failed handler again and mark the letter retried if it succeeds",
    );
    expect(retry.stdout).toContain("<id>");
    expect(retry.stdout).toContain("--actor <id>");
    const discard = await cli(["dead-letters", "discard", "--help"], fixture);
    expect(discard.stdout).toContain("mark the letter discarded without running anything");
    expect(discard.stdout).toContain("the dead letter's id");
    expect(discard.stdout).toContain("--actor <id>");
  });
});

describe("bounda forgotten and bounda forget", () => {
  const fixture = resolve(import.meta.dirname, "fixtures/rebuild-project");

  const open = async () => {
    const project = await loadProject<typeof fixtureRegistry>({
      root: fixture,
      logger: silentLogger,
    });
    return createApp({ ...project, logger: silentLogger });
  };

  const list = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "bounda-cli-forget-"));
    temporary.push(root);
    return root;
  };

  it("prints the persons forgotten since a position or a date, which forget --from takes back", async () => {
    const run = Date.now();
    const [kept, forgotten] = [`m-${run}-kept`, `m-${run}-forgotten`];
    const app = await open();
    await app.commands.join({ memberId: kept, name: "Ana" });
    await app.commands.join({ memberId: forgotten, name: "Bea" });
    const { lastPosition } = await app.getLag();
    const before = new Date(Date.now() - 1).toISOString();
    await app.forget(forgotten);
    const [event] = (await app.events.read({ after: lastPosition })).filter(
      ({ type }) => type === "PersonalDataForgotten",
    );
    await app.stop();

    const byPosition = await cli(["forgotten", "--since", String(lastPosition)], fixture);
    expect(byPosition.code).toBe(EXIT_OK);
    expect(besidesLogs(byPosition.stderr)).toBe("1 person forgotten\n");
    expect(byPosition.stdout).toBe(
      `${JSON.stringify({ personId: forgotten, eventId: event?.id, forgottenAt: event?.timestamp })}\n`,
    );
    const byDate = await cli(["forgotten", "--since", before], fixture);
    expect(byDate.code).toBe(EXIT_OK);
    expect(byDate.stdout).toContain(`"personId":"${forgotten}"`);
    const none = await cli(["forgotten", "--since", "2999-01-01"], fixture);
    expect(none).toMatchObject({ code: EXIT_OK, stdout: "" });
    expect(besidesLogs(none.stderr)).toBe("0 persons forgotten\n");

    const file = join(await list(), "forgotten.jsonl");
    await writeFile(file, `${byPosition.stdout}\n  ${kept}  \n`);
    const forget = await cli(["forget", "--from", file], fixture);
    expect(besidesLogs(forget.stderr)).toBe("");
    expect(forget.code).toBe(EXIT_OK);
    expect(forget.stdout).toBe(
      `forgot again ${kept}\nforgot again 1 of 2 listed; the rest hold no key, or this store holds their forgetting\n`,
    );
    const after = await open();
    const reasons = (await after.events.read({ after: lastPosition, limit: 100 }))
      .filter(({ type }) => type === "PersonalDataForgotten")
      .map(({ aggregateId, payload }) => [aggregateId, (payload as { reason: string }).reason]);
    await after.stop();
    expect(reasons).toEqual([
      [forgotten, "requested"],
      [kept, "restored"],
    ]);
  });

  it("names who forgets again with --actor, in the event's metadata", async () => {
    const memberId = `m-${Date.now()}-acted`;
    const app = await open();
    await app.commands.join({ memberId, name: "Eva" });
    await app.stop();
    const file = join(await list(), "forget.txt");
    await writeFile(file, `${memberId}\n`);
    const forget = await cli(["forget", "--from", file, "--actor", "operator-1"], fixture);
    expect(forget.code).toBe(EXIT_OK);
    expect(logged(forget.stderr, "info", "personal data forgotten")).toEqual([
      expect.objectContaining({ personId: memberId, reason: "restored", actor: "operator-1" }),
    ]);
    const after = await open();
    const forgetting = (await after.events.read({ limit: 1_000 })).find(
      (event) => event.type === "PersonalDataForgotten" && event.aggregateId === memberId,
    );
    await after.stop();
    expect(forgetting?.metadata.actor).toBe("operator-1");
  });

  it("refuses a --since that is neither a position nor a date", async () => {
    for (const since of ["yesterday", "-3", "", "2026-13-45"]) {
      const refused = await cli(["forgotten", "--since", since], fixture);
      expect(refused.code).toBe(EXIT_CONVENTION);
      expect(refused.stderr).toContain(
        "expected a position of the stream, a whole number, or a date such as 2026-11-01",
      );
    }
    expect((await cli(["forgotten"], fixture)).code).toBe(EXIT_CONVENTION);
  });

  it("forgets nobody from a list it cannot read, and says which line is wrong", async () => {
    const root = await list();
    const missing = await cli(["forget", "--from", "nowhere.jsonl"], root);
    expect(missing.code).toBe(EXIT_FAILURE);
    expect(missing.stderr).toMatch(/^error: nowhere\.jsonl: ENOENT/);
    for (const [content, message] of [
      ["m-1\n{not json", "line 2 is neither a person's id nor JSON"],
      ['{"eventId":"e-1"}', 'line 1 needs a "personId" string, and "eventId" only as a string'],
      ['{"personId":"m-1","eventId":7}', 'line 1 needs a "personId" string'],
    ] as const) {
      await writeFile(join(root, "list.jsonl"), content);
      const refused = await cli(["forget", "--from", "list.jsonl", "--root", fixture], root);
      expect(refused.code).toBe(EXIT_FAILURE);
      expect(refused.stderr).toContain(message);
    }
  });

  it("documents both commands in their help", async () => {
    const help = async (command: string) =>
      (await cli([command, "--help"], fixture)).stdout.replace(/\s+/g, " ");
    const forgotten = await help("forgotten");
    expect(forgotten).toContain("--since <date|position>");
    expect(forgotten).toContain("since a position or a date, for bounda forget --from");
    expect(forgotten).toContain(
      "a date such as 2026-11-01, or a position of the stream to read after",
    );
    expect(forgotten).not.toContain("--actor");
    expect((await cli(["generate", "--help"], fixture)).stdout).not.toContain("--actor");
    const forget = await help("forget");
    expect(forget).toContain("--actor <id>");
    expect(forget).toContain("--from <file>");
    expect(forget).toContain("what bounda forgotten printed, or one person's id a line");
    expect(forget).toContain(
      "forget again, after restoring a backup, each person listed who still holds a key and whose forgetting the store does not hold",
    );
  });
});
