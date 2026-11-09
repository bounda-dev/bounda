import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkActor,
  type DeadLetterKind,
  type DeadLetterStatus,
  errorFields,
  type ListDeadLettersArgs,
  type Logger,
  MAX_ACTOR_LENGTH,
  parseDuration,
  rebuildReadModel,
} from "@bounda-dev/core";
import type { Adapter, AdapterDefinition, Storage } from "@bounda-dev/core/adapter";
import type { Config, ErrorText } from "@bounda-dev/core/config";
import { boot, createConsoleLogger, loadProject } from "@bounda-dev/core/node";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { formatLetter, formatRetried } from "./dead-letter-output.ts";
import {
  expireKvLedger,
  type KvLedgerModule,
  type Wrangler,
  wranglerIn,
} from "./forget-ledger-expire.ts";
import { parseForgetList, parseSince, readForgotten, type Since } from "./forgotten.ts";
import { generateProject } from "./generate/generate.ts";
import { ConventionError } from "./generate/problems.ts";
import { watchFromFirstRun } from "./generate/watch.ts";
import { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";

export interface Output {
  write(text: string): void;
}

export interface RunCliArgs {
  // The arguments after the program name: `["generate", "--watch"]`.
  readonly argv: readonly string[];
  readonly cwd: string;
  // What a command prints as its result. Everything else, the app's log lines included, goes to
  // `stderr`, so a result piped into another program is never mixed with them.
  readonly stdout: Output;
  readonly stderr: Output;
  readonly signal?: AbortSignal;
  // How `forget-ledger expire` runs wrangler in a project's root; the project's own by default.
  readonly wrangler?: (root: string) => Wrangler;
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
    const report = await generateProject({
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

const logTo = (stderr: Output): Logger => createConsoleLogger({ stream: stderr });

// The flag wins; without it, what the configuration sets.
const errorTextOf = (options: ProjectOptions, config: Config): ErrorText | undefined =>
  options.errorText ? "include" : config.runtime?.telemetry?.errorText;

const withErrorText = (config: Config, options: ProjectOptions): Config =>
  options.errorText
    ? {
        ...config,
        runtime: {
          ...config.runtime,
          telemetry: { ...config.runtime?.telemetry, errorText: "include" },
        },
      }
    : config;

const rootOf = (options: Pick<ProjectOptions, "root">, cwd: string): string =>
  resolve(cwd, options.root ?? ".");

// What fails while the project's modules load tells of files and exports, never of data a handler
// read, so it is printed in full.
const load = async (
  options: ProjectOptions,
  cwd: string,
  logger: Logger,
  stderr: Output,
): Promise<Awaited<ReturnType<typeof loadProject>> | undefined> => {
  try {
    return await loadProject({
      root: rootOf(options, cwd),
      configPath: options.config,
      registryPath: options.registry,
      logger,
    });
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const ERROR_TEXT_HINT =
  "its message may quote personal data: run again with --error-text to print it";

// A handler's error may quote personal data, and stderr often ends in a log: its message is
// printed only as the runtime would log it.
const failed = (
  stderr: Output,
  error: unknown,
  errorText: ErrorText | undefined,
): typeof EXIT_FAILURE => {
  const { errorName, errorCode, errorMessage } = errorFields({ error, errorText });
  line(
    stderr,
    errorMessage === undefined
      ? `error: ${errorName}${errorCode === undefined ? "" : ` (${errorCode})`}; ${ERROR_TEXT_HINT}`
      : `error: ${errorMessage}`,
  );
  return EXIT_FAILURE;
};

const runRebuild = async (
  readModel: string,
  options: ActingOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const logger = logTo(stderr);
  const project = await load(options, cwd, logger, stderr);
  if (project === undefined) return EXIT_FAILURE;
  try {
    const result = await rebuildReadModel({
      ...project,
      config: withErrorText(project.config, options),
      env: process.env,
      name: readModel,
      logger,
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    line(
      stdout,
      `rebuilt read model "${readModel}": ${result.events} events, checkpoint at position ${result.position}`,
    );
    return EXIT_OK;
  } catch (error) {
    return failed(stderr, error, errorTextOf(options, project.config));
  }
};

interface ProjectOptions {
  readonly root?: string;
  readonly config: string;
  readonly registry: string;
  readonly errorText: boolean;
}

interface ActingOptions extends ProjectOptions {
  readonly actor?: string;
}

interface ListDeadLettersOptions extends ActingOptions {
  readonly kind?: string;
  readonly status?: string;
  readonly handler?: string;
  readonly limit?: number;
  readonly json: boolean;
}

type App = Awaited<ReturnType<typeof boot>>;

const withApp = async <T>(
  options: ProjectOptions,
  cwd: string,
  stderr: Output,
  work: (app: App) => Promise<T>,
): Promise<T | typeof EXIT_FAILURE> => {
  const logger = logTo(stderr);
  const project = await load(options, cwd, logger, stderr);
  if (project === undefined) return EXIT_FAILURE;
  let app: App | undefined;
  try {
    app = await boot({
      root: rootOf(options, cwd),
      config: project.config,
      ...(options.errorText ? { errorText: "include" as const } : {}),
      registry: project.registry,
      loadEnv: false,
      signals: false,
      logger,
    });
    return await work(app);
  } catch (error) {
    return failed(stderr, error, errorTextOf(options, project.config));
  } finally {
    await app?.stop();
  }
};

const actingAs = (app: App, { actor }: ActingOptions) =>
  actor === undefined ? app : app.as(actor);

const parseActor = (value: string): string => {
  try {
    checkActor(value);
  } catch {
    throw new InvalidArgumentError(
      `expected the id of who acts, of 1 to ${MAX_ACTOR_LENGTH} characters`,
    );
  }
  return value;
};

const parseLimit = (value: string): number => {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || value.trim() === "") {
    throw new InvalidArgumentError("expected a whole number of letters, 0 or more");
  }
  return limit;
};

const listFilters = (options: ListDeadLettersOptions): ListDeadLettersArgs => ({
  ...(options.kind === undefined ? {} : { kind: options.kind as DeadLetterKind }),
  ...(options.status === undefined ? {} : { status: options.status as DeadLetterStatus }),
  ...(options.handler === undefined ? {} : { handler: options.handler }),
  ...(options.limit === undefined ? {} : { limit: options.limit }),
});

const runListDeadLetters = (
  options: ListDeadLettersOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const letters = await actingAs(app, options).deadLetters.list(listFilters(options));
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

const runRetryDeadLetter = (
  id: string,
  options: ActingOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    line(stdout, formatRetried(await actingAs(app, options).deadLetters.retry(id)));
    return EXIT_OK;
  });

const runDiscardDeadLetter = (
  id: string,
  options: ActingOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const letter = await actingAs(app, options).deadLetters.discard(id);
    line(
      stdout,
      `discarded dead letter ${id}: ${letter.kind} ${letter.handler} for ${letter.eventType}`,
    );
    return EXIT_OK;
  });

interface ForgottenOptions extends ProjectOptions {
  readonly since: Since;
}

const hasFactories = (definition: AdapterDefinition): definition is Adapter =>
  typeof Reflect.get(definition, "createStorage") === "function";

// Reads the event store alone, without starting the app: no ports, read models or forget ledger,
// so a strict ledger that is down does not keep it from listing what the database holds.
const runForgotten = async (
  options: ForgottenOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const project = await load(options, cwd, logTo(stderr), stderr);
  if (project === undefined) return EXIT_FAILURE;
  const definition: AdapterDefinition = project.config.storage;
  if (!hasFactories(definition)) {
    line(
      stderr,
      `error: storage "${definition.name}" is a definition without factories. Import the adapter package's factory.`,
    );
    return EXIT_FAILURE;
  }
  let storage: Storage | undefined;
  try {
    storage = await definition.createStorage();
    const { eventStore } = storage;
    const lines = await readForgotten({
      events: {
        read: ({ after = 0, limit = 1_000 } = {}) =>
          eventStore.readAll({ afterPosition: after, limit }),
      },
      since: options.since,
    });
    for (const forgotten of lines) line(stdout, JSON.stringify(forgotten));
    line(stderr, `${lines.length} person${lines.length === 1 ? "" : "s"} forgotten`);
    return EXIT_OK;
  } catch (error) {
    return failed(stderr, error, errorTextOf(options, project.config));
  } finally {
    await storage?.close();
  }
};

interface ForgetOptions extends ActingOptions {
  readonly from: string;
}

const runForget = async (
  options: ForgetOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  let entries: ReturnType<typeof parseForgetList>;
  try {
    entries = parseForgetList(await readFile(resolve(cwd, options.from), "utf8"));
  } catch (error) {
    // Its own file, read and parsed here: what fails names the path or the line, never a value.
    line(
      stderr,
      `error: ${options.from}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_FAILURE;
  }
  return withApp(options, cwd, stderr, async (app) => {
    const forgotten = await app.forgetAgain(
      entries,
      options.actor === undefined ? {} : { actor: options.actor },
    );
    for (const personId of forgotten) line(stdout, `forgot again ${personId}`);
    line(
      stdout,
      `forgot again ${forgotten.length} of ${entries.length} listed; the rest hold no key the line names, or this store holds their forgetting`,
    );
    return EXIT_OK;
  });
};

interface ExpireOptions {
  readonly root?: string;
  readonly binding: string;
  readonly keepFor: number;
  readonly local: boolean;
  readonly env?: string;
  readonly wranglerConfig?: string;
  readonly persistTo?: string;
}

const parseKeepFor = (value: string): number => {
  try {
    const keepForMs = parseDuration(value.trim());
    if (keepForMs > 0) return keepForMs;
  } catch {}
  throw new InvalidArgumentError("expected a duration longer than 0, such as 35d");
};

const runExpire = async (
  options: ExpireOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
  wrangler: (root: string) => Wrangler,
): Promise<number> => {
  let ledger: KvLedgerModule;
  try {
    ledger = await import("@bounda-dev/cloudflare/forget-ledger");
  } catch {
    line(
      stderr,
      "error: @bounda-dev/cloudflare is not installed, and the KV forget ledger comes from it",
    );
    return EXIT_FAILURE;
  }
  try {
    const { expired, removed } = await expireKvLedger({
      wrangler: wrangler(rootOf(options, cwd)),
      ledger,
      binding: options.binding,
      keepForMs: options.keepFor,
      target: {
        local: options.local,
        env: options.env,
        config: options.wranglerConfig,
        persistTo: options.persistTo,
      },
      now: Date.now(),
    });
    line(
      stdout,
      `gave ${expired} entr${expired === 1 ? "y" : "ies"} the expiration keepFor sets; removed ${removed} already past it`,
    );
    return EXIT_OK;
  } catch (error) {
    // Wrangler's own failure and the namespace's keys: ids and times, never a person's data.
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};

// Records, so a kind or status added to core fails to compile here until the CLI accepts it.
const DEAD_LETTER_KINDS = Object.keys({
  policy: true,
  process: true,
  scheduled: true,
} satisfies Record<DeadLetterKind, true>);
const DEAD_LETTER_STATUSES = Object.keys({
  failed: true,
  retried: true,
  discarded: true,
} satisfies Record<DeadLetterStatus, true>);

const projectOptions = <T extends Command>(command: T): T =>
  command
    .option("--root <dir>", "project root (default: current directory)")
    .option("--config <file>", "configuration module under the root", "bounda.config.ts")
    .option("--registry <file>", "generated registry module under the root", ".bounda/registry.ts")
    .option(
      "--error-text",
      "print the message of the error a command fails on, and log the text of errors: either may quote personal data",
      false,
    );

const actingOptions = <T extends Command>(command: T): T =>
  projectOptions(command).option(
    "--actor <id>",
    "the id of who runs the command, named in the events it writes, its log lines and the access log",
    parseActor,
  );

export const runCli: RunCliFunction = async ({
  argv,
  cwd,
  stdout,
  stderr,
  signal,
  wrangler = wranglerIn,
}) => {
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
      if (!options.watch) {
        exitCode = await runGenerate(options, cwd, stdout, stderr);
        return;
      }
      const stopped = new AbortController();
      const stop = (): void => stopped.abort();
      if (signal === undefined) {
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }
      try {
        await watchFromFirstRun({
          root: resolve(cwd, options.root ?? "."),
          appDir: options.appDir,
          signal: signal ?? stopped.signal,
          firstRun: async () => {
            exitCode = await runGenerate(options, cwd, stdout, stderr);
            return exitCode !== EXIT_FAILURE;
          },
          onChange: async () => {
            exitCode = await runGenerate(options, cwd, stdout, stderr);
          },
          onUnconfirmed: () =>
            line(
              stderr,
              `warning: the file system has not reported a change under ${options.appDir}/; watching may miss changes`,
            ),
          onWatching: () => line(stderr, `watching ${options.appDir}/ for changes`),
        });
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    });

  actingOptions(
    program
      .command("rebuild")
      .description("rebuild a read model from the whole stream into a fresh table and swap it in")
      .argument("<read-model>", "the read model's key in the registry, e.g. orderSummary"),
  ).action(async (readModel: string, options: ActingOptions) => {
    exitCode = await runRebuild(readModel, options, cwd, stdout, stderr);
  });

  const deadLetters = program
    .command("dead-letters")
    .description("list, retry or discard the handler runs that gave up");
  actingOptions(
    deadLetters
      .command("list")
      .description("list dead letters, failed ones by default")
      .addOption(
        new Option("--kind <kind>", "only letters of this kind").choices(DEAD_LETTER_KINDS),
      )
      .addOption(
        new Option("--status <status>", "only letters in this status")
          .choices(DEAD_LETTER_STATUSES)
          .default("failed"),
      )
      .option("--handler <name>", "the policy, process or scheduled command that failed")
      .option("--limit <n>", "at most this many letters", parseLimit)
      .option("--json", "print the letters as JSON", false),
  ).action(async (options: ListDeadLettersOptions) => {
    exitCode = await runListDeadLetters(options, cwd, stdout, stderr);
  });
  actingOptions(
    deadLetters
      .command("retry")
      .description("run the failed handler again and mark the letter retried if it succeeds")
      .argument("<id>", "the dead letter's id"),
  ).action(async (id: string, options: ActingOptions) => {
    exitCode = await runRetryDeadLetter(id, options, cwd, stdout, stderr);
  });
  actingOptions(
    deadLetters
      .command("discard")
      .description("mark the letter discarded without running anything")
      .argument("<id>", "the dead letter's id"),
  ).action(async (id: string, options: ActingOptions) => {
    exitCode = await runDiscardDeadLetter(id, options, cwd, stdout, stderr);
  });

  projectOptions(
    program
      .command("forgotten")
      .description(
        "print, one JSON line each, the persons forgotten since a position or a date, for bounda forget --from",
      )
      .requiredOption(
        "--since <date|position>",
        "a date such as 2026-11-01, or a position of the stream to read after",
        parseSince,
      ),
  ).action(async (options: ForgottenOptions) => {
    exitCode = await runForgotten(options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("forget")
      .description(
        "forget again, after restoring a backup, each person listed who still holds a key and whose forgetting the store does not hold",
      )
      .requiredOption("--from <file>", "what bounda forgotten printed, or one person's id a line"),
  ).action(async (options: ForgetOptions) => {
    exitCode = await runForget(options, cwd, stdout, stderr);
  });

  program
    .command("forget-ledger")
    .description("look after a forget ledger outside the app")
    .command("expire")
    .description(
      "give every entry of a Workers KV forget ledger the expiration keepFor sets, those written before it was set included",
    )
    .requiredOption("--binding <name>", "the KV namespace's binding in wrangler.jsonc")
    .requiredOption(
      "--keep-for <duration>",
      "runtime.personalData.forgetLedger.keepFor, such as 35d",
      parseKeepFor,
    )
    .option("--local", "the local state of wrangler dev instead of the deployed namespace", false)
    .option("--env <name>", "the wrangler environment")
    .option("--wrangler-config <path>", "the wrangler configuration file")
    .option("--persist-to <dir>", "with --local, where wrangler dev keeps its state")
    .option("--root <dir>", "the project's root directory, where wrangler is installed")
    .action(async (options: ExpireOptions) => {
      exitCode = await runExpire(options, cwd, stdout, stderr, wrangler);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_OK : EXIT_CONVENTION;
    }
    return failed(stderr, error, undefined);
  }
};
