import { createReadStream, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  checkActor,
  type DeadLetterKind,
  type DeadLetterStatus,
  errorFields,
  isUnreadable,
  type ListDeadLettersArgs,
  type Logger,
  MAX_ACTOR_LENGTH,
  migrateTables,
  parseDuration,
  personalDataExportJson,
  personalDataInventory,
  RESTRICTION_GROUNDS,
  type Registry,
  type RestrictionGround,
  type RestrictionNotice,
  readTenantExport,
  rebuildReadModel,
  resolveErrorText,
  rewrapTenantKeys,
  type SubscriberFailure,
  type TenantExportPart,
  tenantExportJsonLines,
  unreadableParts,
  withEncryptedFiles,
  withErrorText,
} from "@bounda-dev/core";
import {
  type AdapterDefinition,
  type FileEncryptionState,
  isAdapter,
  type Storage,
} from "@bounda-dev/core/adapter";
import type { Config, ErrorText } from "@bounda-dev/core/config";
import { boot, createConsoleLogger, loadProject } from "@bounda-dev/core/node";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { formatLetter, formatRetried } from "./dead-letter-output.ts";
import { formatTenantExportCounts, writeToFile, writeToOutput } from "./export-output.ts";
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
import { formatInventory, formatInventoryMarkdown } from "./inventory-output.ts";
import { parseRedactionList } from "./redaction-list.ts";
import { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";
import {
  formatFiles,
  formatRecipients,
  formatRestored,
  formatSchema,
  formatStatus,
} from "./status-output.ts";
import { standInWorkersRuntime } from "./workers-runtime.ts";

export interface Output {
  // `false`, as a Node stream answers, when it holds more than it should until it drains.
  write(text: string): unknown;
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

// `process.env` is read once `load` has loaded `.env` and checked `BOUNDA_ERROR_TEXT`.
const errorTextArgs = (options: ProjectOptions, config: Config) => ({
  forced: options.errorText ? ("include" as const) : undefined,
  env: process.env,
  config,
});

const rootOf = (options: Pick<ProjectOptions, "root">, cwd: string): string =>
  resolve(cwd, options.root ?? ".");

// What fails while the project's modules load, or a `BOUNDA_ERROR_TEXT` it does not know, tells of
// files, exports and settings, never of data a handler read, so it is printed in full.
const load = async (
  options: ProjectOptions,
  cwd: string,
  logger: Logger,
  stderr: Output,
): Promise<Awaited<ReturnType<typeof loadProject>> | undefined> => {
  try {
    const project = await loadProject({
      root: rootOf(options, cwd),
      configPath: options.config,
      registryPath: options.registry,
      logger,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    });
    resolveErrorText({ env: process.env });
    return project;
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

const ERROR_TEXT_HINT =
  "its message may quote personal data: run again with --error-text to print it";

// A handler's error may quote personal data, and stderr often ends in a log: its message is
// printed only as the runtime would log it.
const failed = (stderr: Output, error: unknown, errorText: ErrorText): typeof EXIT_FAILURE => {
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
    const { tenant: _tenant, ...loaded } = project;
    const result = await rebuildReadModel({
      ...loaded,
      config: withErrorText(errorTextArgs(options, project.config)),
      env: process.env,
      name: readModel,
      logger,
      ...(project.tenant === undefined ? {} : { tenant: project.tenant }),
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    line(
      stdout,
      `rebuilt read model "${readModel}": ${result.events} events, checkpoint at position ${result.position}`,
    );
    return EXIT_OK;
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, project.config)));
  }
};

interface ProjectOptions {
  readonly root?: string;
  readonly config: string;
  readonly registry: string;
  readonly errorText: boolean;
  readonly tenant?: string;
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
      ...(project.tenant === undefined ? {} : { tenant: project.tenant }),
    });
    return await work(app);
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, project.config)));
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

interface ExportOptions extends ActingOptions {
  readonly output?: string;
  readonly includeWithheld: boolean;
}

// Written as it is read, whatever the person's history: what they asked for, where the operator
// sends it.
const runExport = (
  personId: string,
  options: ExportOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const body = personalDataExportJson(
      await actingAs(app, options).streamPersonalData(personId, {
        includeWithheld: options.includeWithheld,
      }),
    );
    if (options.output === undefined) {
      await writeToOutput(stdout, body);
      stdout.write("\n");
    } else {
      const path = resolve(cwd, options.output);
      await writeToFile(path, body);
      line(stderr, `exported ${personId} to ${path}`);
    }
    return EXIT_OK;
  });

interface ForgottenOptions extends ProjectOptions {
  readonly since: Since;
}

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
  if (!isAdapter(project.config.storage)) {
    line(
      stderr,
      `error: storage "${project.config.storage.name}" is a definition without factories. Import the adapter package's factory.`,
    );
    return EXIT_FAILURE;
  }
  try {
    const lines = await withEncryptedFiles({
      config: project.config,
      env: process.env,
      ...(project.tenant === undefined ? {} : { tenant: project.tenant }),
      work: async (config) => {
        const definition: AdapterDefinition = config.storage;
        if (!isAdapter(definition)) return [];
        let storage: Storage | undefined;
        try {
          storage = await definition.createStorage();
          const { eventStore } = storage;
          return await readForgotten({
            events: {
              read: ({ after = 0, limit = 1_000 } = {}) =>
                eventStore.readAll({ afterPosition: after, limit }),
            },
            since: options.since,
          });
        } finally {
          await storage?.close();
        }
      },
    });
    for (const forgotten of lines) line(stdout, JSON.stringify(forgotten));
    line(stderr, `${lines.length} person${lines.length === 1 ? "" : "s"} forgotten`);
    return EXIT_OK;
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, project.config)));
  }
};

interface ForgetOptions extends ActingOptions {
  readonly from?: string;
  readonly category?: readonly string[];
  readonly objection?: boolean;
}

const collect = (value: string, previous: readonly string[] = []): readonly string[] => [
  ...previous,
  value,
];

const runForgetPerson = (
  personId: string,
  options: ForgetOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const categories = options.category;
    const objection = options.objection === true;
    await actingAs(app, options).forget(personId, {
      ...(categories === undefined ? {} : { categories }),
      ...(objection ? { objection } : {}),
    });
    line(
      stdout,
      `${categories === undefined ? `forgot ${personId}` : `forgot ${categories.join(", ")} of ${personId}`}${objection ? " after their objection" : ""}`,
    );
    return EXIT_OK;
  });

const runForget = async (
  personId: string | undefined,
  options: ForgetOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  if ((personId === undefined) === (options.from === undefined)) {
    line(stderr, "error: name one person, or a list with --from, not both");
    return EXIT_CONVENTION;
  }
  if (personId !== undefined) return runForgetPerson(personId, options, cwd, stdout, stderr);
  if (options.category !== undefined || options.objection !== undefined) {
    line(
      stderr,
      "error: --category and --objection forget one person; a list says what each line asked for",
    );
    return EXIT_CONVENTION;
  }
  const from = options.from as string;
  let entries: ReturnType<typeof parseForgetList>;
  try {
    entries = parseForgetList(await readFile(resolve(cwd, from), "utf8"));
  } catch (error) {
    // Its own file, read and parsed here: what fails names the path or the line, never a value.
    line(stderr, `error: ${from}: ${error instanceof Error ? error.message : String(error)}`);
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

interface RestrictCommandOptions extends ActingOptions {
  readonly ground: RestrictionGround;
  readonly category?: readonly string[];
}

const groundOption = (description: string): Option =>
  new Option("--ground <ground>", description).choices(RESTRICTION_GROUNDS);

const runRestrict = (
  personId: string,
  options: RestrictCommandOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const { ground, category: categories } = options;
    const restricted = await actingAs(app, options).restrict(personId, {
      ground,
      ...(categories === undefined ? {} : { categories }),
    });
    const what = categories === undefined ? personId : `${categories.join(", ")} of ${personId}`;
    line(
      stdout,
      restricted.eventIds.length === 0
        ? `${what} was restricted on ${ground} already`
        : `restricted ${what} on ${ground}`,
    );
    return EXIT_OK;
  });

interface RedactCommandOptions extends ActingOptions {
  readonly from: string;
}

const runRedact = async (
  personId: string,
  options: RedactCommandOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const { from } = options;
  let events: ReturnType<typeof parseRedactionList>;
  try {
    events = parseRedactionList(await readFile(resolve(cwd, from), "utf8"));
  } catch (error) {
    line(stderr, `error: ${from}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
  return withApp(options, cwd, stderr, async (app) => {
    const redacted = await actingAs(app, options).redact(personId, { events });
    const listed = new Set(events.map(({ id }) => id)).size;
    line(
      stdout,
      redacted.eventIds.length === 0
        ? `nothing of ${personId} left to redact: what was listed reads as null already`
        : `redacted ${listed === 1 ? "1 event" : `${listed} events`} of ${personId}`,
    );
    return EXIT_OK;
  });
};

interface UnrestrictCommandOptions extends ActingOptions {
  readonly notice: RestrictionNotice;
  readonly ground?: RestrictionGround;
  readonly category?: readonly string[];
}

const parseNotice = (value: string): RestrictionNotice => {
  const notice = value.trim();
  if (notice === "given") return notice;
  try {
    if (parseDuration(notice) > 0) return notice as RestrictionNotice;
  } catch {}
  throw new InvalidArgumentError(
    'expected how long before the lift the person is told, such as 7d, or "given" when they were told already',
  );
};

const runUnrestrict = (
  personId: string,
  options: UnrestrictCommandOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const { notice, ground, category: categories } = options;
    const lifted = await actingAs(app, options).unrestrict(personId, {
      notice,
      ...(ground === undefined ? {} : { ground }),
      ...(categories === undefined ? {} : { categories }),
    });
    const what = categories === undefined ? personId : `${categories.join(", ")} of ${personId}`;
    const [type] = lifted.eventTypes;
    line(
      stdout,
      type === undefined
        ? `${what} has no restriction to lift${ground === undefined ? "" : ` on ${ground}`}`
        : type === "ProcessingRestrictionLifted"
          ? `lifted the restriction of ${what}`
          : `announced the lift of the restriction of ${what}, lifted ${String(notice)} from now`,
    );
    return EXIT_OK;
  });

interface ExpireOptions {
  readonly root?: string;
  readonly errorText: boolean;
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
    return failed(
      stderr,
      error,
      resolveErrorText({ forced: options.errorText ? "include" : undefined, env: process.env }),
    );
  }
};

interface StatusOptions extends ActingOptions {
  readonly json: boolean;
}

// The text of each failure is opened only under the app's rule for error text, `--error-text`
// included, through the call the access log records. A part that could not be read is printed as
// such, named on stderr, and fails the run, as a status that could not be read at all did.
const runStatus = (
  options: StatusOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const status = await app.status();
    let opened: readonly SubscriberFailure[] | undefined;
    let unopened = false;
    // Not once the status found their store down: the read would only fail again.
    if (
      app.config.runtime.telemetry.errorText === "include" &&
      !isUnreadable(status.subscriberFailures)
    ) {
      try {
        opened = await actingAs(app, options).subscriberFailures.list();
      } catch (error) {
        failed(stderr, error, app.config.runtime.telemetry.errorText);
        unopened = true;
      }
    }
    if (options.json) {
      line(
        stdout,
        JSON.stringify(
          opened === undefined ? status : { ...status, subscriberFailures: opened },
          null,
          2,
        ),
      );
    } else {
      line(
        stdout,
        formatStatus({
          status,
          ...(opened === undefined
            ? {}
            : { opened: new Map<string, SubscriberFailure>(opened.map((f) => [f.subscriber, f])) }),
        }),
      );
    }
    const unread = [...unreadableParts(status), ...(unopened ? ["the failures' text"] : [])];
    if (unread.length === 0) return EXIT_OK;
    line(stderr, `error: could not read ${unread.join(", ")}; see the logs`);
    return EXIT_FAILURE;
  });

interface RecipientsOptions extends ActingOptions {
  readonly json: boolean;
}

// With a person, what they may ask for (article 19), as JSON, recorded in the access log; without
// one, every recipient and what waits on it.
const runRecipients = (
  personId: string | undefined,
  options: RecipientsOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    if (personId !== undefined) {
      line(stdout, JSON.stringify(await actingAs(app, options).recipientsOf(personId), null, 2));
      return EXIT_OK;
    }
    const { recipients } = await app.status();
    if (isUnreadable(recipients)) {
      line(stderr, "error: could not read recipients; see the logs");
      return EXIT_FAILURE;
    }
    if (options.json) line(stdout, JSON.stringify(recipients, null, 2));
    else for (const text of formatRecipients(recipients)) line(stdout, text);
    return EXIT_OK;
  });

interface InventoryOptions extends ProjectOptions {
  readonly json: boolean;
  readonly markdown: boolean;
}

// Read from the modules and the configuration alone: nothing opens the database, nor runs what
// a Cloudflare project imports from its runtime.
const runInventory = async (
  options: InventoryOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  standInWorkersRuntime();
  const project = await load(options, cwd, logTo(stderr), stderr);
  if (project === undefined) return EXIT_FAILURE;
  let inventory: ReturnType<typeof personalDataInventory>;
  try {
    inventory = personalDataInventory({ registry: project.registry, config: project.config });
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
  line(
    stdout,
    options.json
      ? JSON.stringify(inventory, null, 2)
      : options.markdown
        ? formatInventoryMarkdown(inventory)
        : formatInventory(inventory),
  );
  return inventory.findings.length === 0 ? EXIT_OK : EXIT_CONVENTION;
};

interface ForgetTenantOptions extends ActingOptions {
  readonly yes: boolean;
  readonly despiteLegalObligations: boolean;
}

const runForgetTenant = (
  tenant: string,
  options: ForgetTenantOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  if (!options.yes) {
    line(
      stderr,
      `error: forgetting tenant ${tenant} destroys its key: nothing personal of it opens again, in the database or in any backup, and the app serves nothing more. Run again with --yes to forget it`,
    );
    return Promise.resolve(EXIT_FAILURE);
  }
  return withApp({ ...options, tenant: options.tenant ?? tenant }, cwd, stderr, async (app) => {
    const forgotten = await actingAs(app, options).forgetTenant(tenant, {
      despiteLegalObligations: options.despiteLegalObligations,
    });
    // Its notices go out from the app's own worker, which the next start runs.
    line(
      stdout,
      `forgot tenant ${forgotten.tenant} at ${forgotten.forgottenAt} (event ${forgotten.eventId}); the app tells its recipients in the background`,
    );
    return EXIT_OK;
  });
};

type HeaderPart = Extract<TenantExportPart, { readonly kind: "header" }>;

type EndPart = Extract<TenantExportPart, { readonly kind: "end" }>;

interface ExportTenantOptions extends ActingOptions {
  readonly output?: string;
}

// Written as it is read, whatever the tenant holds: the controller's data, where the operator
// hands it over. Said done only once the export's end came, so a file is whole.
const runExportTenant = (
  tenant: string,
  options: ExportTenantOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp({ ...options, tenant: options.tenant ?? tenant }, cwd, stderr, async (app) => {
    const parts = await actingAs(app, options).exportTenant(tenant);
    // The export ends with its counts, or rejects.
    let last: TenantExportPart | undefined;
    const noted = async function* (): AsyncGenerator<TenantExportPart, void, undefined> {
      for await (const part of parts) {
        last = part;
        yield part;
      }
    };
    const body = tenantExportJsonLines(noted());
    let where = "standard output";
    if (options.output === undefined) await writeToOutput(stdout, body);
    else {
      where = resolve(cwd, options.output);
      await writeToFile(where, body);
    }
    line(
      stderr,
      `exported tenant ${tenant} to ${where}: ${formatTenantExportCounts((last as EndPart).counts)}; check it with bounda check-tenant-export before forgetting the tenant`,
    );
    return EXIT_OK;
  });

// Reads the file alone, without the app: what the operator runs on the copy they hand over.
const runCheckTenantExport = async (
  file: string,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const path = resolve(cwd, file);
  try {
    // Read whole, it starts with its header and ends with its counts.
    let first: TenantExportPart | undefined;
    let last: TenantExportPart | undefined;
    for await (const part of readTenantExport(createReadStream(path))) {
      first ??= part;
      last = part;
    }
    const { tenant, position } = (first as HeaderPart).header;
    line(
      stdout,
      `${path} is a whole export of tenant ${tenant} up to position ${position}: ${formatTenantExportCounts((last as EndPart).counts)}`,
    );
    return EXIT_OK;
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};

interface RotateTenantKeyOptions extends ActingOptions {
  readonly reseal: boolean;
}

const runRotateTenantKey = (
  options: RotateTenantKeyOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const { kid, previous } = await actingAs(app, options).rotateTenantKey(
      options.reseal ? { reseal: true } : undefined,
    );
    line(
      stdout,
      options.reseal
        ? `tenant key ${kid} in force; the worker replaces every key that seals personal data and seals it all again under the new ones, which bounda status follows, then retire ${previous.join(", ")} with bounda tenant-key retire`
        : `tenant key ${kid} in force; the worker rewraps every key under it, then retire ${previous.join(", ")} with bounda tenant-key retire`,
    );
    return EXIT_OK;
  });

const runRetireTenantKeys = (
  options: ActingOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    const retired = await actingAs(app, options).retireTenantKeys();
    line(
      stdout,
      retired.length === 0
        ? "no older version of the tenant key to retire"
        : `retired ${retired.join(", ")}: a backup with keys wrapped under them opens nothing personal any more`,
    );
    return EXIT_OK;
  });

const runRestored = (
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> =>
  withApp(options, cwd, stderr, async (app) => {
    await app.restored();
    line(stdout, formatRestored((await app.status()).restoresFound));
    return EXIT_OK;
  });

// In place, through the adapter's own engine, which counts the restore in the same transaction.
const runRestore = async (
  copy: string,
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const logger = logTo(stderr);
  const project = await load(options, cwd, logger, stderr);
  if (project === undefined) return EXIT_FAILURE;
  const { config, tenant } = project;
  let unsupported: string | null = null;
  try {
    await withEncryptedFiles({
      config,
      env: process.env,
      logger,
      ...(tenant === undefined ? {} : { tenant }),
      work: async ({ storage }) => {
        if (!isAdapter(storage) || storage.restore === undefined) unsupported = storage.name;
        else await storage.restore({ copy: resolve(cwd, copy) });
      },
    });
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, config)));
  }
  // Names the adapter alone: printed in full.
  if (unsupported !== null) {
    line(
      stderr,
      `error: storage "${unsupported}" is restored with its engine's own tools: see https://docs.bounda.dev/guides/backups/`,
    );
    return EXIT_FAILURE;
  }
  line(
    stdout,
    `restored ${copy} in place, in one transaction: running instances find the restore at their next pass, and a stopped app when it starts`,
  );
  return EXIT_OK;
};

// Opens every database file the configuration encrypts under the tenant's keys, as a start would,
// which encrypts under the key in force a file left in the clear or under an earlier key, and
// tries again on any still waiting: what an operator runs once the file is the process's alone.
const runRekey = async (
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const logger = logTo(stderr);
  let config: Config;
  let tenant: string | undefined;
  try {
    ({ config, tenant } = await loadProject({
      root: rootOf(options, cwd),
      configPath: options.config,
      registry: NO_REGISTRY,
      logger,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    }));
    resolveErrorText({ env: process.env });
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
  try {
    const files = await withEncryptedFiles({
      config,
      env: process.env,
      logger,
      ...(tenant === undefined ? {} : { tenant }),
      work: async (keyed) => {
        const databases: (readonly [string, AdapterDefinition])[] = [
          ["storage", keyed.storage],
          ...Object.entries(keyed.readModels ?? {}).map(
            ([name, adapter]) => [`readModels.${name}`, adapter] as const,
          ),
        ];
        const settled: { database: string; file: string; state: FileEncryptionState }[] = [];
        const seen = new Set<AdapterDefinition>();
        for (const [database, adapter] of databases) {
          if (seen.has(adapter) || !isAdapter(adapter) || adapter.fileEncryption === undefined) {
            continue;
          }
          seen.add(adapter);
          settled.push({
            database,
            file: adapter.fileEncryption.database,
            state: await adapter.fileEncryption.settle(),
          });
        }
        return settled;
      },
    });
    if (files.length === 0) {
      line(stdout, "no database file is encrypted under the tenant's keys");
      return EXIT_OK;
    }
    line(stdout, formatFiles(files).join("\n"));
    return files.every(({ state }) => state === "current") ? EXIT_OK : EXIT_FAILURE;
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, config)));
  }
};

// Only the configuration is read: the tables are migrated before any app of this release starts.
const NO_REGISTRY: Registry = { aggregates: {}, readModels: {} };

const runMigrate = async (
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const logger = logTo(stderr);
  let config: Config;
  let tenant: string | undefined;
  try {
    ({ config, tenant } = await loadProject({
      root: rootOf(options, cwd),
      configPath: options.config,
      registry: NO_REGISTRY,
      logger,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    }));
    resolveErrorText({ env: process.env });
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
  try {
    const migrated = await migrateTables({
      config,
      env: process.env,
      ...(tenant === undefined ? {} : { tenant }),
    });
    line(stdout, `migrated\n${formatSchema(migrated)}`);
    return EXIT_OK;
  } catch (error) {
    return failed(stderr, error, resolveErrorText(errorTextArgs(options, config)));
  }
};

const runRewrapMaster = async (
  options: ProjectOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  // A Cloudflare project's configuration loads, so its store says where the rotation runs.
  standInWorkersRuntime();
  const logger = logTo(stderr);
  let config: Config;
  try {
    ({ config } = await loadProject({
      root: rootOf(options, cwd),
      configPath: options.config,
      registry: NO_REGISTRY,
      logger,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    }));
    resolveErrorText({ env: process.env });
  } catch (error) {
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
  const errorText = resolveErrorText(errorTextArgs(options, config));
  try {
    const { rewrapped, left } = await rewrapTenantKeys({ config, env: process.env });
    for (const tenant of rewrapped) line(stdout, `rewrapped ${tenant}`);
    if (left.length === 0) {
      line(
        stdout,
        `${rewrapped.length} tenant key(s) rewrapped; none is left under a previous master key: remove them`,
      );
      return EXIT_OK;
    }
    for (const { tenant, error } of left) {
      const { errorName, errorMessage } = errorFields({ error, errorText });
      line(
        stderr,
        `error: ${tenant} is still under a previous master key: ${errorMessage ?? errorName}`,
      );
    }
    line(
      stderr,
      `${left.length} tenant key(s) left under a previous master key: keep the previous master keys until none is`,
    );
    return EXIT_FAILURE;
  } catch (error) {
    return failed(stderr, error, errorText);
  }
};

// Records, so a kind or status added to core fails to compile here until the CLI accepts it.
const DEAD_LETTER_KINDS = Object.keys({
  policy: true,
  process: true,
  scheduled: true,
  recipient: true,
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
    )
    .option(
      "--tenant <name>",
      "the tenant the app serves, for a configuration that is a function of the tenant (default: BOUNDA_TENANT)",
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
      .option("--handler <name>", "the policy, process, scheduled command or port that failed")
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
        "forget a person, or some categories of theirs; with --from, forget again, after restoring a backup, each person listed who still holds a key and whose forgetting the store does not hold",
      )
      .argument("[person]", "the id of the person to forget")
      .option(
        "--category <name>",
        "forget only this category of the person, as when a consent is withdrawn; repeat it for several",
        collect,
      )
      .option(
        "--objection",
        "after an objection you upheld (article 21): of what it reaches, keep only what a legal obligation or legal claims keep",
      )
      .option("--from <file>", "what bounda forgotten printed, or one person's id a line"),
  ).action(async (personId: string | undefined, options: ForgetOptions) => {
    exitCode = await runForget(personId, options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("restrict")
      .description(
        "restrict the processing of a person's data on a ground of article 18(1), or of some categories of theirs: from then on it is only kept",
      )
      .argument("<person>", "the id of the person to restrict")
      .addOption(groundOption("why, as article 18(1) names it").makeOptionMandatory())
      .option(
        "--category <name>",
        "restrict only this category of the person; repeat it for several",
        collect,
      ),
  ).action(async (personId: string, options: RestrictCommandOptions) => {
    exitCode = await runRestrict(personId, options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("unrestrict")
      .description(
        "lift a person's restrictions, telling them first: with a notice, announce the lift and lift it that long after; with given, lift it at once",
      )
      .argument("<person>", "the id of the person whose restrictions to lift")
      .requiredOption(
        "--notice <duration|given>",
        'how long before the lift the person is told, such as 7d, or "given" when they were told already',
        parseNotice,
      )
      .addOption(groundOption("lift only the restrictions on this ground"))
      .option(
        "--category <name>",
        "lift only this category from restrictions of categories; repeat it for several",
        collect,
      ),
  ).action(async (personId: string, options: UnrestrictCommandOptions) => {
    exitCode = await runUnrestrict(personId, options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("redact")
      .description(
        "rectify a person's data (article 16): seal for good the fields listed of their events, which read as null from then on everywhere, and have every read model write null over its copies",
      )
      .argument("<person>", "the id of the person whose data is wrong")
      .requiredOption(
        "--from <file>",
        "the events, one a line as JSON, each as the person's export lists it with the fields to redact: {aggregateType, aggregateId, type, id, fields}",
      ),
  ).action(async (personId: string, options: RedactCommandOptions) => {
    exitCode = await runRedact(personId, options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("recipients")
      .description(
        "print every recipient a port sends personal data to, how many persons were disclosed to it and its failed notices; with a person, print as JSON the recipients of their data, recorded in the access log",
      )
      .argument("[person]", "the id of the person whose recipients to print")
      .option("--json", "print every recipient as JSON", false),
  ).action(async (personId: string | undefined, options: RecipientsOptions) => {
    exitCode = await runRecipients(personId, options, cwd, stdout, stderr);
  });

  const personalData = program
    .command("personal-data")
    .description("describe the personal data the app processes, and export a person's");
  projectOptions(
    personalData
      .command("inventory")
      .description(
        "print the record of processing activities (GDPR article 30) the modules and the configuration describe, and exit 1 while a field is not classified or looks personal unmarked",
      )
      .addOption(new Option("--json", "print it as JSON").default(false).conflicts("markdown"))
      .addOption(new Option("--markdown", "print it as a Markdown document").default(false)),
  ).action(async (options: InventoryOptions) => {
    exitCode = await runInventory(options, cwd, stdout, stderr);
  });
  actingOptions(
    personalData
      .command("export")
      .description(
        "write, as JSON, everything the store holds that names a person, with each field's category, basis and retention, read and written a page at a time; recorded in the access log",
      )
      .argument("<person>", "the id of the person to export")
      .option(
        "--output <file>",
        "write it to this file, readable by its owner alone, and only once whole, instead of printing it",
      )
      .option(
        "--include-withheld",
        "open, still marked, the text article 15(4) holds back because it may quote someone else's data, for the controller to weigh before handing it over",
        false,
      ),
  ).action(async (personId: string, options: ExportOptions) => {
    exitCode = await runExport(personId, options, cwd, stdout, stderr);
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
    .option("--error-text", "print the message of the error the command fails on", false)
    .action(async (options: ExpireOptions) => {
      exitCode = await runExpire(options, cwd, stdout, stderr, wrangler);
    });

  actingOptions(
    program
      .command("status")
      .description(
        "print the version of the tables, every subscriber's lag and last failure, and how the backfill, forget ledger, key rotation and retention stand",
      )
      .option("--json", "print the status as JSON", false),
  ).action(async (options: StatusOptions) => {
    exitCode = await runStatus(options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("forget-tenant")
      .description(
        "forget a tenant as a whole: destroy its key, so nothing personal of it opens again in the database, its backups or a Durable Object's copies, and the app serves nothing but the notices to its recipients",
      )
      .argument("<tenant>", "the tenant to forget, the one the app serves")
      .option("--yes", "confirm: the tenant's data cannot be read again", false)
      .option(
        "--despite-legal-obligations",
        "destroy too the keys a legal obligation keeps, once their data was handed back",
        false,
      ),
  ).action(async (tenant: string, options: ForgetTenantOptions) => {
    exitCode = await runForgetTenant(tenant, options, cwd, stdout, stderr);
  });

  actingOptions(
    program
      .command("export-tenant")
      .description(
        "hand a tenant's data back to its controller, as JSON Lines: every person, event, scheduled command, dead letter, subscriber failure, remembered answer, read model row and forget ledger entry, every value opened, read and written a page at a time; recorded in the access log",
      )
      .argument("<tenant>", "the tenant to export, the one the app serves")
      .option(
        "--output <file>",
        "write it to this file, readable by its owner alone, and only once whole, instead of printing it",
      ),
  ).action(async (tenant: string, options: ExportTenantOptions) => {
    exitCode = await runExportTenant(tenant, options, cwd, stdout, stderr);
  });

  program
    .command("check-tenant-export")
    .description(
      "check that a file bounda export-tenant wrote is whole, every part in its place and counted by its end, before the tenant is forgotten",
    )
    .argument("<file>", "the file the export was written to")
    .action(async (file: string) => {
      exitCode = await runCheckTenantExport(file, cwd, stdout, stderr);
    });

  const tenantKey = program
    .command("tenant-key")
    .description("rotate the tenant's key, and retire its older versions");
  actingOptions(
    tenantKey
      .command("rotate")
      .description(
        "put a new version of the tenant's key in force: the worker rewraps every person's key and the database's key under it",
      )
      .option(
        "--reseal",
        "after a leak of the persons' keys themselves: replace every key that seals personal data, and the database's key, and seal it all again under the new ones",
        false,
      ),
  ).action(async (options: RotateTenantKeyOptions) => {
    exitCode = await runRotateTenantKey(options, cwd, stdout, stderr);
  });
  actingOptions(
    tenantKey
      .command("retire")
      .description(
        "remove the older versions of the tenant's key once nothing is wrapped under them: backups that need them open nothing personal any more",
      ),
  ).action(async (options: ActingOptions) => {
    exitCode = await runRetireTenantKeys(options, cwd, stdout, stderr);
  });
  projectOptions(
    tenantKey
      .command("rewrap-master")
      .description(
        "rewrap under the master key in force the key of every tenant the tenant key store holds, their apps running or not: once none is left under a previous master key, remove those",
      ),
  ).action(async (options: ProjectOptions) => {
    exitCode = await runRewrapMaster(options, cwd, stdout, stderr);
  });

  projectOptions(
    program
      .command("restore")
      .argument(
        "<copy>",
        "the copy of the database file, taken with VACUUM INTO or the sqlite3 shell",
      )
      .description(
        "put a copy of a SQLite file back in place, in one transaction through the app's own engine, under a running app or not",
      ),
  ).action(async (copy: string, options: ProjectOptions) => {
    exitCode = await runRestore(copy, options, cwd, stdout, stderr);
  });

  projectOptions(
    program
      .command("restored")
      .description(
        "say the database was restored from a copy while the app was stopped: every instance starts its background jobs over, without the holds the copy brought back",
      ),
  ).action(async (options: ProjectOptions) => {
    exitCode = await runRestored(options, cwd, stdout, stderr);
  });

  program
    .command("rekey")
    .description(
      "encrypt under the tenant's key in force every database file still in the clear or under an earlier key; exits with 2 while another connection keeps one from it",
    )
    .option("--root <dir>", "project root (default: current directory)")
    .option("--config <file>", "configuration module under the root", "bounda.config.ts")
    .option(
      "--tenant <name>",
      "the tenant whose files to encrypt, for a configuration that is a function of the tenant (default: BOUNDA_TENANT)",
    )
    .action(async (options: ProjectOptions) => {
      exitCode = await runRekey({ ...options, errorText: false }, cwd, stdout, stderr);
    });

  program
    .command("migrate")
    .description(
      "bring Bounda's tables to this release's version in every database of the configuration, before a deploy",
    )
    .option("--root <dir>", "project root (default: current directory)")
    .option("--config <file>", "configuration module under the root", "bounda.config.ts")
    .option(
      "--tenant <name>",
      "the tenant whose databases to migrate, for a configuration that is a function of the tenant (default: BOUNDA_TENANT)",
    )
    .action(async (options: ProjectOptions) => {
      exitCode = await runMigrate({ ...options, errorText: false }, cwd, stdout, stderr);
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_OK : EXIT_CONVENTION;
    }
    return failed(stderr, error, resolveErrorText({ env: process.env, ignoreInvalidEnv: true }));
  }
};
