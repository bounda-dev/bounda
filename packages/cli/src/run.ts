import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type DeadLetter,
  type DeadLetterKind,
  type DeadLetterStatus,
  type ListDeadLettersArgs,
  rebuildReadModel,
} from "@bounda-dev/core";
import { boot, loadProject } from "@bounda-dev/core/node";
import { Command, CommanderError } from "commander";
import { generate } from "./generate/generate.ts";
import { ConventionError } from "./generate/problems.ts";
import { watchProject } from "./generate/watch.ts";
import { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";

export interface Output {
  write(text: string): void;
}

export interface RunCliArgs {
  /**
   * The arguments after the program name, e.g. `["generate", "--watch"]`.
   */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  /**
   * Aborting it ends `--watch`.
   */
  readonly signal?: AbortSignal;
}

export interface RunCliFunction {
  (args: RunCliArgs): Promise<number>;
}

export const EXIT_OK: number = 0;
export const EXIT_CONVENTION: number = 1;
export const EXIT_FAILURE: number = 2;

interface GenerateOptions {
  readonly root?: string;
  readonly appDir: string;
  readonly tsconfig?: string;
  readonly infer: boolean;
  readonly watch: boolean;
}

const version = (): string => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string };
  return packageJson.version;
};

const line = (output: Output, text: string): void => {
  if (text.length > 0) output.write(`${text}\n`);
};

const runGenerate = async (
  options: GenerateOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const root = resolve(cwd, options.root ?? ".");
  try {
    const report = await generate({
      root,
      appDir: options.appDir,
      inferState: options.infer,
      ...(options.tsconfig === undefined ? {} : { tsconfigPath: resolve(root, options.tsconfig) }),
    });
    line(stderr, formatWarnings(report));
    line(stdout, formatReport({ report, root }));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ConventionError) {
      line(stderr, formatConventionError({ error, root }));
      return EXIT_CONVENTION;
    }
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};

type RebuildOptions = ProjectOptions;

const runRebuild = async (
  readModel: string,
  options: RebuildOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const root = resolve(cwd, options.root ?? ".");
  try {
    const project = await loadProject({
      root,
      configPath: options.config,
      registryPath: options.registry,
    });
    const result = await rebuildReadModel({ ...project, name: readModel });
    line(
      stdout,
      `rebuilt read model "${readModel}": ${result.events} events, checkpoint at position ${result.position}`,
    );
    return EXIT_OK;
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};

interface ProjectOptions {
  readonly root?: string;
  readonly config: string;
  readonly registry: string;
}

interface ListDeadLettersOptions extends ProjectOptions {
  readonly kind?: string;
  readonly status?: string;
  readonly subscriber?: string;
  readonly limit?: string;
  readonly json: boolean;
}

const formatLetter = (letter: DeadLetter): string =>
  [
    `${letter.id}  ${letter.status}  ${letter.kind}  ${letter.subscriber}`,
    `    ${letter.eventType} on ${letter.aggregateType}:${letter.aggregateId}, ${letter.attempts} attempt${letter.attempts === 1 ? "" : "s"}, last ${letter.lastFailedAt} (${letter.errorType})`,
    `    ${letter.errorMessage}`,
  ].join("\n");

const withApp = async <T>(
  options: ProjectOptions,
  cwd: string,
  stderr: Output,
  work: (app: Awaited<ReturnType<typeof boot>>) => Promise<T>,
): Promise<T | typeof EXIT_FAILURE> => {
  const root = resolve(cwd, options.root ?? ".");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    app = await boot({
      root,
      configPath: options.config,
      registryPath: options.registry,
      signals: false,
    });
    return await work(app);
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  } finally {
    await app?.stop();
  }
};

const listFilters = (options: ListDeadLettersOptions): ListDeadLettersArgs => ({
  ...(options.kind === undefined ? {} : { kind: options.kind as DeadLetterKind }),
  ...(options.status === undefined ? {} : { status: options.status as DeadLetterStatus }),
  ...(options.subscriber === undefined ? {} : { subscriber: options.subscriber }),
  ...(options.limit === undefined ? {} : { limit: Number(options.limit) }),
});

const runListDeadLetters = (
  options: ListDeadLettersOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const letters = await app.deadLetters.list(listFilters(options));
    if (options.json) {
      line(stdout, JSON.stringify(letters, null, 2));
    } else if (letters.length === 0) {
      line(stdout, "no dead letters");
    } else {
      for (const letter of letters) line(stdout, formatLetter(letter));
      line(stdout, `${letters.length} dead letter${letters.length === 1 ? "" : "s"}`);
    }
    return EXIT_OK;
  });

const runReplayDeadLetter = (
  id: string,
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const letter = await app.deadLetters.replay(id);
    line(
      stdout,
      `replayed dead letter ${id}: ${letter.kind} ${letter.subscriber} for ${letter.eventType}`,
    );
    return EXIT_OK;
  });

const runDiscardDeadLetter = (
  id: string,
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const letter = await app.deadLetters.discard(id);
    line(
      stdout,
      `discarded dead letter ${id}: ${letter.kind} ${letter.subscriber} for ${letter.eventType}`,
    );
    return EXIT_OK;
  });

const projectOptions = <T extends Command>(command: T): T =>
  command
    .option("--root <dir>", "project root (default: current directory)")
    .option("--config <file>", "configuration module under the root", "bounda.config.ts")
    .option("--registry <file>", "generated registry module under the root", ".bounda/registry.ts");

/**
 * The `bounda` command line, as a function: parses `argv`, runs the command and returns the exit
 * code instead of exiting, so it can be tested and embedded.
 */
export const runCli: RunCliFunction = async ({ argv, cwd, stdout, stderr, signal }) => {
  let exitCode = EXIT_OK;
  const program = new Command("bounda")
    .description("Bounda: event sourcing and CQRS for TypeScript")
    .version(version(), "-v, --version")
    .configureOutput({
      writeOut: (text) => stdout.write(text),
      writeErr: (text) => stderr.write(text),
    })
    .exitOverride();

  program
    .command("generate")
    .description("write .bounda/registry.ts, .bounda/types.ts and the +types of every module")
    .option("--root <dir>", "project root (default: current directory)")
    .option("--app-dir <dir>", "application directory under the root", "app")
    .option("--tsconfig <file>", "tsconfig used to infer state (default: <root>/tsconfig.json)")
    .option("--no-infer", "do not infer state for aggregates without state.ts")
    .option("--watch", "regenerate when a module changes", false)
    .action(async (options: GenerateOptions) => {
      exitCode = await runGenerate(options, cwd, stdout, stderr);
      if (!options.watch || exitCode === EXIT_FAILURE) return;
      const root = resolve(cwd, options.root ?? ".");
      line(stdout, `watching ${options.appDir}/ for changes`);
      await watchProject({
        root,
        appDir: options.appDir,
        signal: signal ?? new AbortController().signal,
        onChange: async () => {
          exitCode = await runGenerate(options, cwd, stdout, stderr);
        },
      });
    });

  projectOptions(
    program
      .command("rebuild")
      .description("rebuild a read model from the whole stream into a fresh table and swap it in")
      .argument("<read-model>", "the read model's key in the registry, e.g. orderSummary"),
  ).action(async (readModel: string, options: RebuildOptions) => {
    exitCode = await runRebuild(readModel, options, cwd, stdout, stderr);
  });

  const deadLetters = program
    .command("dead-letters")
    .description("list, replay or discard the handler runs that gave up");
  projectOptions(
    deadLetters
      .command("list")
      .description("list dead letters, failed ones by default")
      .option("--kind <kind>", "policy, process or command")
      .option("--status <status>", "failed, replayed or discarded", "failed")
      .option("--subscriber <name>", "the policy, process or scheduled command that failed")
      .option("--limit <n>", "at most this many letters")
      .option("--json", "print the letters as JSON", false),
  ).action(async (options: ListDeadLettersOptions) => {
    exitCode = await runListDeadLetters(options, cwd, stdout, stderr);
  });
  projectOptions(
    deadLetters
      .command("replay")
      .description("run the failed handler again and mark the letter replayed if it succeeds")
      .argument("<id>", "the dead letter's id"),
  ).action(async (id: string, options: ProjectOptions) => {
    exitCode = await runReplayDeadLetter(id, options, cwd, stdout, stderr);
  });
  projectOptions(
    deadLetters
      .command("discard")
      .description("mark the letter discarded without running anything")
      .argument("<id>", "the dead letter's id"),
  ).action(async (id: string, options: ProjectOptions) => {
    exitCode = await runDiscardDeadLetter(id, options, cwd, stdout, stderr);
  });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_OK : EXIT_CONVENTION;
    }
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};
