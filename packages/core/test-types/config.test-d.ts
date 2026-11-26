import type {
  AppStatus,
  DeadLetterRetentionStanding,
  ExportedTransfer,
  InventoryTransfer,
  PersonalDataExport,
  PersonalDataExportHeader,
  PersonalDataForgottenReason,
  RedactedEvent,
  StoreSafeguard,
  SubscriberFailureRetentionStanding,
  TransferSafeguard,
  UnreadableRetentionStatus,
} from "@bounda-dev/core";
import {
  ConfigurationError,
  type DurationInput,
  ERROR_TEXT_VARIABLE,
  type ErrorFields,
  errorFields,
  type InventoryFindingKind,
  type InventoryRecordName,
  resolveErrorText,
  STORE_SAFEGUARDS,
  type SubscriberFailing,
  TRANSFER_ARTICLES,
  withErrorText,
} from "@bounda-dev/core";
import type {
  Adapter,
  AdapterDefinition,
  DataLocationOptions,
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerMark,
  LedgerDisclosure,
  LedgerReached,
  LedgerRedaction,
  LedgerRestriction,
  Placement,
  PruneForgetLedgerArgs,
  ReadForgetLedgerArgs,
  RuntimeTextFunction,
  TenantFence,
} from "@bounda-dev/core/adapter";
import { placementOf, runtimeText } from "@bounda-dev/core/adapter";
import {
  type Config,
  DEFAULT_DEAD_LETTER_RETENTION_MS,
  defineConfig,
  defineForgetLedger,
  defineKeyWrapper,
  defineTenantKeyStore,
  type ErrorText,
  type ForgetLedgerConfig,
  type ForgetLedgerDefinition,
  type ForgetLedgerSource,
  type KeyWrapper,
  type KeyWrapperDefinition,
  masterKey,
  type ResolvedConfig,
  type StoreDefinitionOptions,
  type TenantKeyStoreDefinition,
} from "@bounda-dev/core/config";
import { type MemoryOptions, memory } from "@bounda-dev/core/memory";
import { describe, expectTypeOf, it } from "vitest";

declare const sqlite: AdapterDefinition<"sqlite", { path: string }>;
declare const env: Readonly<Record<string, string | undefined>>;

/**
 * The fixture registers its `PortsConfig` through `register.d.ts`, and `inventory` has two
 * implementations, so every config here has to choose one.
 */
const ports = { order: { inventory: "fake" } } as const;

describe("errorFields", () => {
  it("logs an error by its class and code, its text optional, under the rule of the configuration", () => {
    expectTypeOf(errorFields({ error: new Error("x") })).toEqualTypeOf<ErrorFields>();
    expectTypeOf(
      errorFields({ error: "thrown", errorText: undefined as ErrorText | undefined }),
    ).toEqualTypeOf<ErrorFields>();
    expectTypeOf<ErrorFields>().toEqualTypeOf<{
      readonly errorName: string;
      readonly errorCode?: string;
      readonly errorMessage?: string;
      readonly errorStack?: string;
    }>();
    // @ts-expect-error errorText is "omit" or "include"
    errorFields({ error: null, errorText: "all" });
    expectTypeOf<SubscriberFailing["errorName"]>().toEqualTypeOf<string>();
    expectTypeOf<SubscriberFailing>().not.toHaveProperty("message");
  });

  it("resolves one rule from a host's override, any environment, the configuration and a fallback", () => {
    expectTypeOf(ERROR_TEXT_VARIABLE).toEqualTypeOf<"BOUNDA_ERROR_TEXT">();
    const processEnv: Readonly<Record<string, string | undefined>> = {};
    expectTypeOf(resolveErrorText({})).toEqualTypeOf<ErrorText>();
    expectTypeOf(
      resolveErrorText({
        forced: undefined,
        env: processEnv,
        config: { storage: sqlite, ports },
        fallback: "include",
        ignoreInvalidEnv: true,
      }),
    ).toEqualTypeOf<ErrorText>();
    expectTypeOf(
      withErrorText({ config: { storage: sqlite, ports }, env: processEnv }),
    ).toEqualTypeOf<Config>();
    // @ts-expect-error an environment is an object
    resolveErrorText({ env: "include" });
    // @ts-expect-error a fallback is "omit" or "include"
    resolveErrorText({ fallback: "all" });
    // @ts-expect-error withErrorText needs the configuration it sets the rule in
    withErrorText({ forced: "include" });
  });
});

describe("defineConfig", () => {
  it("keeps the literal type of what it is given", () => {
    const config = defineConfig({ storage: sqlite, ports, runtime: { role: "worker" } });
    expectTypeOf(config.runtime.role).toEqualTypeOf<"worker">();
    expectTypeOf(config.storage).toEqualTypeOf<AdapterDefinition<"sqlite", { path: string }>>();
    expectTypeOf(config.ports.order.inventory).toEqualTypeOf<"fake">();
  });

  it("checks the ports section against the project's ports", () => {
    defineConfig({ storage: sqlite, ports: { order: { inventory: "memory" } } });
    defineConfig({
      storage: sqlite,
      ports: { order: { inventory: "fake", mailer: "memory", reminders: "fake" } },
    });
    const chosen = env.INVENTORY === "memory" ? "memory" : "fake";
    defineConfig({ storage: sqlite, ports: { order: { inventory: chosen } } });
  });

  it("checks a read model's ports in the same section", () => {
    defineConfig({ storage: sqlite, ports: { ...ports, orderSummary: { rates: "fixed" } } });
    // @ts-expect-error "ecb" is not an implementation of rates
    defineConfig({ storage: sqlite, ports: { ...ports, orderSummary: { rates: "ecb" } } });
  });

  it("checks duration strings at compile time", () => {
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: { timeout: "10s" },
        policies: { timeout: "30s" },
        processes: { timeout: "7d", handlerTimeout: "1m" },
        overrides: {
          order: { commands: { timeout: 5_000 }, processes: { handlerTimeout: 90_000 } },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { commands: { idempotencyKeyLifetime: "48h" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: {
          // @ts-expect-error "two days" is not a duration string
          idempotencyKeyLifetime: "two days",
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        overrides: {
          order: { snapshot: { every: 200 } },
          customer: { snapshot: { every: 50, verify: 0.1, version: 2 } },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { pollInterval: 250 } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { projectionBatchTime: "500ms" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { projectionBatchTime: 0 } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { catchUp: { timeout: "5s", pollInterval: 20 } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          catchUp: {
            // @ts-expect-error "two seconds" is not a duration string
            timeout: "two seconds",
          },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { dispatcher: { backoff: { baseDelay: "250ms", maxDelay: 60_000 } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          backoff: {
            // @ts-expect-error "a minute" is not a duration string
            maxDelay: "a minute",
          },
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        dispatcher: {
          // @ts-expect-error "half a second" is not a duration string
          projectionBatchTime: "half a second",
        },
      },
    });
    // @ts-expect-error "7 days" is not a duration string
    defineConfig({ storage: sqlite, ports, runtime: { policies: { timeout: "7 days" } } });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        commands: {
          // @ts-expect-error "ten seconds" is not a duration string
          timeout: "ten seconds",
        },
      },
    });
    // @ts-expect-error "48x" uses an unknown unit
    defineConfig({ storage: sqlite, ports, runtime: { processes: { timeout: "48x" } } });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        processes: {
          // @ts-expect-error "a minute" is not a duration string
          handlerTimeout: "a minute",
        },
      },
    });
  });

  it("rejects unknown keys and wrong roles", () => {
    // @ts-expect-error storag is not a config key
    defineConfig({ storag: sqlite, ports });
    expectTypeOf<Config>().not.toHaveProperty("rootDir");
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error concurrencyRetries is not overridden per aggregate
      runtime: { overrides: { order: { commands: { concurrencyRetries: 1 } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error idempotencyKeyLifetime is not overridden per aggregate
      runtime: { overrides: { order: { commands: { idempotencyKeyLifetime: "1h" } } } },
    });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: "30d" } } });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: 86_400_000 } } });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: "6y" } } });
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { retention: "18mo" } } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error "a month" is not a duration string
      runtime: { personalData: { retention: "a month" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the retention is app-wide, never per aggregate
      runtime: { overrides: { order: { personalData: { retention: "30d" } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        personalData: {
          retention: "30d",
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", previous: ["BOUNDA_MASTER_KEY_OLD"] }),
        },
      },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the master key is named by its variable, never given as a value
      runtime: { personalData: { keyWrapper: "BOUNDA_MASTER_KEY" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error a wrapper is given through defineKeyWrapper, not as it is
      runtime: { personalData: { keyWrapper: {} as KeyWrapper } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the key wrapper is app-wide, never per aggregate
      runtime: { overrides: { order: { personalData: { keyWrapper: masterKey({ from: "K" }) } } } },
    });
    defineConfig({ storage: sqlite, ports, runtime: { deadLetters: { retention: "30d" } } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error "a month" is not a duration string
      runtime: { deadLetters: { retention: "a month" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the retention of dead letters is app-wide, never per aggregate
      runtime: { overrides: { order: { deadLetters: { retention: "30d" } } } },
    });
    defineConfig({ storage: sqlite, ports, runtime: { subscriberFailures: { retention: "7d" } } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error "a week" is not a duration string
      runtime: { subscriberFailures: { retention: "a week" } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the retention of subscriber failures is app-wide, never per aggregate
      runtime: { overrides: { order: { subscriberFailures: { retention: "7d" } } } },
    });
    // Resolved letters are always purged: the retention has a default, never `null`.
    expectTypeOf<ResolvedConfig["runtime"]["deadLetters"]>().toEqualTypeOf<{
      readonly retentionMs: number;
    }>();
    expectTypeOf(DEFAULT_DEAD_LETTER_RETENTION_MS).toEqualTypeOf<number>();
    // A purge whose store cannot be read is reported, never thrown: narrow on `unreadable`.
    expectTypeOf<NonNullable<AppStatus["deadLetterRetention"]>>().toEqualTypeOf<
      | {
          readonly retentionMs: number;
          readonly nextDueAt: string | null;
          readonly held: number;
          readonly withoutHandler: number;
        }
      | { readonly retentionMs: number; readonly unreadable: true }
    >();
    expectTypeOf<NonNullable<AppStatus["subscriberFailureRetention"]>>().toEqualTypeOf<
      SubscriberFailureRetentionStanding | UnreadableRetentionStatus
    >();
    expectTypeOf<DeadLetterRetentionStanding>().not.toHaveProperty("unreadable");
    defineConfig({ storage: sqlite, ports, runtime: { telemetry: { errorText: "include" } } });
    defineConfig({ storage: sqlite, ports, runtime: { telemetry: { errorText: "omit" } } });
    expectTypeOf<NonNullable<NonNullable<Config["runtime"]>["telemetry"]>>().toEqualTypeOf<{
      readonly errorText?: ErrorText;
    }>();
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error errorText is "omit" or "include", never a boolean
      runtime: { telemetry: { errorText: true } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error what the telemetry carries is app-wide, never per aggregate
      runtime: { overrides: { order: { telemetry: { errorText: "include" } } } },
    });
    // @ts-expect-error batch is not a role
    defineConfig({ storage: sqlite, ports, runtime: { role: "batch" } });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error every is a number of events
      runtime: { overrides: { order: { snapshot: { every: "200" } } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error snapshots are opted into per aggregate, not app-wide
      runtime: { snapshot: { every: 200 } },
    });
  });

  it("requires storage to be an adapter definition", () => {
    // @ts-expect-error a plain object is not an adapter definition
    defineConfig({ storage: { path: "./x.db" }, ports });
  });

  it("types the key wrappers: masterKey names variables, defineKeyWrapper builds one from env", () => {
    expectTypeOf(masterKey).parameter(0).toEqualTypeOf<
      DataLocationOptions & {
        readonly from: string;
        readonly previous?: readonly string[];
      }
    >();
    expectTypeOf(masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" }).location).toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<Parameters<typeof defineKeyWrapper>[1]>().toEqualTypeOf<
      DataLocationOptions | undefined
    >();
    // @ts-expect-error a location is a jurisdiction's name, such as "eu"
    masterKey({ from: "BOUNDA_MASTER_KEY", location: 7 });
    expectTypeOf(masterKey({ from: "BOUNDA_MASTER_KEY" })).toEqualTypeOf<KeyWrapperDefinition>();
    const kms = defineKeyWrapper(({ env: received }) => {
      expectTypeOf(received).toEqualTypeOf(env);
      return {
        kid: "arn:aws:kms:eu-west-1:1:key/1",
        wrap: async (key) => {
          expectTypeOf(key).toEqualTypeOf<Uint8Array>();
          return key;
        },
        unwrap: async ({ kid, wrapped }) => {
          expectTypeOf(kid).toEqualTypeOf<string>();
          return wrapped;
        },
      };
    });
    expectTypeOf(kms).toEqualTypeOf<KeyWrapperDefinition>();
    expectTypeOf<KeyWrapper["previous"]>().toEqualTypeOf<readonly string[] | undefined>();
    // @ts-expect-error a wrapper names the key it wraps under
    defineKeyWrapper(() => ({
      wrap: async (key: Uint8Array) => key,
      unwrap: async () => new Uint8Array(),
    }));
    defineConfig({ storage: sqlite, ports, runtime: { personalData: { keyWrapper: kms } } });
  });

  it("takes as forget ledger an adapter of another database or a ledger definition", () => {
    const ledgerDatabase = {} as Adapter<"sqlite", { path: string }>;
    defineConfig({
      storage: sqlite,
      ports,
      runtime: { personalData: { forgetLedger: { store: ledgerDatabase } } },
    });
    const own = defineForgetLedger(({ env: environment, tenant, keepForMs }) => {
      expectTypeOf(environment).toEqualTypeOf<typeof env>();
      expectTypeOf(tenant).toEqualTypeOf<string>();
      expectTypeOf(keepForMs).toEqualTypeOf<number | undefined>();
      return {
        append: async (entries) => {
          expectTypeOf(entries).toEqualTypeOf<readonly ForgetLedgerEntry[]>();
        },
        read: async (args) => {
          expectTypeOf(args).toEqualTypeOf<ReadForgetLedgerArgs>();
          return [];
        },
        prune: async (args) => {
          expectTypeOf(args).toEqualTypeOf<PruneForgetLedgerArgs>();
        },
        readMark: async (name) => {
          expectTypeOf(name).toEqualTypeOf<string>();
          return [{ value: 0, raisedAt: "2026-01-01T00:00:00.000Z" }];
        },
        raiseMark: async (name, mark) => {
          expectTypeOf(name).toEqualTypeOf<string>();
          expectTypeOf(mark).toEqualTypeOf<ForgetLedgerMark>();
        },
        pruneMarks: async (name, before) => {
          expectTypeOf(name).toEqualTypeOf<string>();
          expectTypeOf(before).toEqualTypeOf<string>();
        },
        clear: async () => true,
        fence: {
          read: async () => ({ state: "open" }),
          set: async (fence) => {
            expectTypeOf(fence).toEqualTypeOf<TenantFence>();
            return fence;
          },
        },
      };
    });
    expectTypeOf(own).toEqualTypeOf<ForgetLedgerDefinition>();
    expectTypeOf(
      defineForgetLedger(() => ({}) as ForgetLedger, { location: "eu" }).location,
    ).toEqualTypeOf<string | undefined>();
    // @ts-expect-error a location is a jurisdiction's name, such as "eu"
    defineForgetLedger(() => ({}) as ForgetLedger, { location: ["eu"] });
    defineConfig({
      storage: sqlite,
      ports,
      runtime: {
        personalData: {
          forgetLedger: {
            store: own,
            reconcileEvery: "1m",
            strict: true,
            keepFor: "35d",
            timeout: "5s",
          },
        },
      },
    });
    expectTypeOf<ForgetLedgerConfig>().toEqualTypeOf<{
      readonly store: ForgetLedgerSource;
      readonly reconcileEvery?: DurationInput;
      readonly strict?: boolean;
      readonly keepFor?: DurationInput;
      readonly timeout?: DurationInput;
    }>();
    expectTypeOf<ForgetLedgerEntry>().toEqualTypeOf<{
      readonly personId: string;
      readonly categories: readonly string[] | null;
      readonly eventId: string;
      readonly forgottenAt: string;
      readonly reason: PersonalDataForgottenReason;
      readonly fingerprints?: readonly string[];
      readonly restriction?: LedgerRestriction;
      readonly redaction?: LedgerRedaction;
      readonly disclosure?: LedgerDisclosure;
      readonly committed?: false;
      readonly reached?: LedgerReached;
    }>();
    expectTypeOf<LedgerReached>().toEqualTypeOf<{
      readonly position: number;
      readonly generation: number;
    }>();
    expectTypeOf<LedgerDisclosure>().toEqualTypeOf<{
      readonly port: string;
      readonly recipient: string;
      readonly kind: string;
      readonly country: string;
      readonly safeguard: string | null;
      readonly category: string;
    }>();
    expectTypeOf<LedgerRedaction>().toEqualTypeOf<{
      readonly events: readonly RedactedEvent[];
    }>();
    expectTypeOf<RedactedEvent>().toEqualTypeOf<{
      readonly id: string;
      readonly aggregateType: string;
      readonly aggregateId: string;
      readonly type: string;
      readonly fields: readonly string[];
    }>();
    expectTypeOf<LedgerRestriction["type"]>().toEqualTypeOf<
      "ProcessingRestricted" | "ProcessingRestrictionLiftAnnounced" | "ProcessingRestrictionLifted"
    >();
    expectTypeOf<PruneForgetLedgerArgs>().toEqualTypeOf<{ readonly before: string }>();
    expectTypeOf<ForgetLedger["visibilityDelayMs"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ForgetLedger["prune"]>().toEqualTypeOf<
      ((args: PruneForgetLedgerArgs) => Promise<void>) | undefined
    >();
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error the ledger goes under store, with its options beside it
      runtime: { personalData: { forgetLedger: ledgerDatabase } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error a definition without factories opens no ledger
      runtime: { personalData: { forgetLedger: { store: sqlite } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error a ledger is given through defineForgetLedger, not as it is
      runtime: { personalData: { forgetLedger: { store: {} as ForgetLedger } } },
    });
    defineConfig({
      storage: sqlite,
      ports,
      // @ts-expect-error strict is a boolean
      runtime: { personalData: { forgetLedger: { store: own, strict: "yes" } } },
    });
    // @ts-expect-error a ledger reads in pages
    defineForgetLedger(() => ({ append: async () => {}, read: async () => [] as string[] }));
  });
});

describe("runtimeText", () => {
  it("vouches for an error's message and hands the same error back, typed as it was", () => {
    const refusal = runtimeText(new ConfigurationError("The Worker has no binding KEEPER"));
    expectTypeOf(refusal).toEqualTypeOf<ConfigurationError>();
    expectTypeOf(runtimeText).toEqualTypeOf<RuntimeTextFunction>();
    // @ts-expect-error only an error is vouched for
    runtimeText("The Worker has no binding KEEPER");
  });
});

describe("location", () => {
  it("lets every adapter declare the jurisdiction it keeps its data in, which the record states", () => {
    expectTypeOf<DataLocationOptions>().toEqualTypeOf<
      | { readonly location?: string; readonly safeguard?: never }
      | { readonly location: string; readonly safeguard: StoreSafeguard }
    >();
    expectTypeOf<AdapterDefinition["location"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<MemoryOptions>().toEqualTypeOf<DataLocationOptions>();
    expectTypeOf(memory({ location: "eu" }).location).toEqualTypeOf<string | undefined>();
    // @ts-expect-error a location is a jurisdiction's name, such as "eu"
    memory({ location: ["eu"] });
    defineConfig({
      storage: memory({ location: "eu" }),
      ports,
      readModels: { search: memory({ location: "eu" }) },
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
          tenantKeys: memory({ location: "eu" }),
        },
      },
    });
    expectTypeOf<"tenant-keys">().toExtend<InventoryRecordName>();
    expectTypeOf<"master-key">().toExtend<InventoryRecordName>();
    expectTypeOf<"no-location">().toExtend<InventoryFindingKind>();
  });

  it("lets a store be kept in another location than storage's under a safeguard of articles 45 to 47", () => {
    expectTypeOf<StoreSafeguard>().toEqualTypeOf<Exclude<TransferSafeguard, "derogation">>();
    expectTypeOf(STORE_SAFEGUARDS).toEqualTypeOf<readonly StoreSafeguard[]>();
    expectTypeOf(TRANSFER_ARTICLES).toEqualTypeOf<Readonly<Record<TransferSafeguard, string>>>();
    expectTypeOf<AdapterDefinition["safeguard"]>().toEqualTypeOf<StoreSafeguard | undefined>();
    expectTypeOf<StoreDefinitionOptions>().toEqualTypeOf<DataLocationOptions>();
    expectTypeOf<TenantKeyStoreDefinition["safeguard"]>().toEqualTypeOf<
      StoreSafeguard | undefined
    >();
    expectTypeOf<ForgetLedgerDefinition["safeguard"]>().toEqualTypeOf<StoreSafeguard | undefined>();
    expectTypeOf<KeyWrapperDefinition["safeguard"]>().toEqualTypeOf<StoreSafeguard | undefined>();
    expectTypeOf(memory({ location: "ch", safeguard: "adequacy" }).safeguard).toEqualTypeOf<
      StoreSafeguard | undefined
    >();
    expectTypeOf(placementOf).returns.toEqualTypeOf<Placement>();
    defineConfig({
      storage: memory({ location: "eu" }),
      ports,
      readModels: { search: memory({ location: "ch", safeguard: "adequacy" }) },
      runtime: {
        personalData: {
          keyWrapper: masterKey({
            from: "BOUNDA_MASTER_KEY",
            location: "us",
            safeguard: "standard-contractual-clauses",
          }),
          tenantKeys: defineTenantKeyStore(() => ({}) as never, {
            location: "ch",
            safeguard: "adequacy",
          }),
          forgetLedger: {
            store: defineForgetLedger(() => ({}) as ForgetLedger, {
              location: "us",
              safeguard: "binding-corporate-rules",
            }),
          },
        },
      },
    });
    // @ts-expect-error a safeguard allows keeping data in a location, so it comes with one
    memory({ safeguard: "adequacy" });
    // @ts-expect-error a derogation covers occasional transfers alone, never a store
    memory({ location: "us", safeguard: "derogation" });
    // @ts-expect-error a safeguard is one of articles 45 to 47
    defineForgetLedger(() => ({}) as ForgetLedger, { location: "us", safeguard: "privacy-shield" });
    expectTypeOf<InventoryTransfer>().toEqualTypeOf<{
      readonly safeguard: StoreSafeguard;
      readonly article: string;
    }>();
    expectTypeOf<ExportedTransfer>().toEqualTypeOf<{
      readonly store: "read-model" | "master-key" | "tenant-keys" | "forget-ledger";
      readonly readModel: string | null;
      readonly location: string;
      readonly safeguard: StoreSafeguard;
      readonly article: string;
    }>();
    expectTypeOf<PersonalDataExport["transfers"]>().toEqualTypeOf<readonly ExportedTransfer[]>();
    expectTypeOf<PersonalDataExportHeader["transfers"]>().toEqualTypeOf<
      readonly ExportedTransfer[]
    >();
  });
});
