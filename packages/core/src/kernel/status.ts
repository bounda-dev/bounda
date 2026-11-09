import type { Adapter, SchemaScopeName, SchemaVersion } from "../adapter/adapter.ts";
import { isAdapter } from "../adapter/adapter.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../adapter/storage/subscriber-failure-store.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { AppLag } from "./app.ts";
import type { DeadLetterRetention, DeadLetterRetentionStatus } from "./dead-letters/retention.ts";
import type { PersonalDataBackfill } from "./personal-data/backfill.ts";
import type {
  ForgetLedgerReconciliation,
  ForgetLedgerReconciliationStatus,
} from "./personal-data/reconciliation.ts";
import type { RetentionStatus, RetentionSweep } from "./personal-data/retention.ts";
import type { KeyRotation, KeyRotationStatus } from "./personal-data/rotation.ts";
import type { RestoreWatch } from "./shared/restores.ts";

/**
 * A scope of Bounda's tables where it lives: `storage`, a read model's database of its own as
 * `readModels.<name>`, or `forgetLedger`.
 */
export interface SchemaStatus extends SchemaVersion {
  readonly database: string;
}

/**
 * A subscriber's last failure without its text, which `subscriberFailures` opens. `current` while
 * the subscriber is still stuck on it.
 */
export interface SubscriberFailureStatus
  extends Omit<StoredSubscriberFailure, "errorMessage" | "errorStack"> {
  readonly current: boolean;
}

/**
 * Where the runtime's background work stands, as the database says: what `bounda status` prints.
 * Nothing in it is personal data, so reading it records nothing in the access log.
 */
export interface AppStatus {
  /**
   * Every scope of Bounda's tables the app uses, at the version its database holds beside the
   * latest this version of Bounda migrates it to.
   */
  readonly schema: readonly SchemaStatus[];
  /**
   * How many times a running instance found the database gone back to an earlier copy.
   */
  readonly restoresFound: number;
  readonly lag: AppLag;
  readonly subscriberFailures: readonly SubscriberFailureStatus[];
  /**
   * `null` when no schema marks personal data.
   */
  readonly personalDataBackfill: AppLag["personalDataBackfill"];
  /**
   * `null` without `runtime.personalData.forgetLedger`.
   */
  readonly forgetLedger: ForgetLedgerReconciliationStatus | null;
  /**
   * `null` without `runtime.personalData.keyWrapper`.
   */
  readonly keyRotation: KeyRotationStatus | null;
  /**
   * `null` without `runtime.personalData.retention`.
   */
  readonly retention: RetentionStatus | null;
  /**
   * `null` without `runtime.deadLetters.retention`.
   */
  readonly deadLetterRetention: DeadLetterRetentionStatus | null;
}

export interface ReadAppStatusArgs {
  readonly config: ResolvedConfig;
  readonly lag: () => Promise<AppLag>;
  readonly failures: SubscriberFailureStore;
  readonly restores: RestoreWatch;
  readonly backfill?: PersonalDataBackfill | undefined;
  readonly reconciliation?: ForgetLedgerReconciliation | undefined;
  readonly rotation?: KeyRotation | undefined;
  readonly retention?: RetentionSweep | undefined;
  readonly letterRetention?: DeadLetterRetention | undefined;
}

export interface ReadAppStatusFunction {
  (args: ReadAppStatusArgs): Promise<AppStatus>;
}

interface Database {
  readonly database: string;
  readonly adapter: Adapter;
  readonly scopes: readonly SchemaScopeName[];
}

// Each database the configuration names, once, with the scopes it keeps there.
const databasesOf = (config: ResolvedConfig): readonly Database[] => {
  const databases: Database[] = [];
  if (isAdapter(config.storage)) {
    databases.push({
      database: "storage",
      adapter: config.storage,
      scopes: ["storage", "checkpoints"],
    });
  }
  for (const [name, adapter] of Object.entries(config.readModels)) {
    if (!isAdapter(adapter) || databases.some((known) => known.adapter === adapter)) continue;
    databases.push({ database: `readModels.${name}`, adapter, scopes: ["checkpoints"] });
  }
  const ledger = config.runtime.personalData.forgetLedger?.store;
  if (isAdapter(ledger)) {
    databases.push({ database: "forgetLedger", adapter: ledger, scopes: ["forget-ledger"] });
  }
  return databases;
};

const schemaOf = async ({ database, adapter, scopes }: Database): Promise<SchemaStatus[]> =>
  (await adapter.schemaVersions())
    .filter(({ scope }) => (scopes as readonly string[]).includes(scope))
    .map((version) => ({ database, ...version }));

export const readAppStatus: ReadAppStatusFunction = async ({
  config,
  lag,
  failures,
  restores,
  backfill,
  reconciliation,
  rotation,
  retention,
  letterRetention,
}) => {
  const [schema, restoresFound, current, stored, forgetLedger, keyRotation, retained, purged] =
    await Promise.all([
      Promise.all(databasesOf(config).map(schemaOf)).then((all) => all.flat()),
      restores.found(),
      lag(),
      failures.list(),
      reconciliation?.status() ?? null,
      rotation?.status() ?? null,
      retention?.status() ?? null,
      letterRetention?.status() ?? null,
    ]);
  const positions = new Map(current.subscribers.map((each) => [each.subscriber, each.position]));
  return {
    schema,
    restoresFound,
    lag: current,
    // A subscriber the app no longer runs is stuck on nothing.
    subscriberFailures: stored.map(({ errorMessage: _message, errorStack: _stack, ...failure }) => {
      const position = positions.get(failure.subscriber);
      return {
        ...failure,
        current:
          failure.resolvedAt === null && position !== undefined && position < failure.position,
      };
    }),
    personalDataBackfill: backfill === undefined ? null : await backfill.status(),
    forgetLedger,
    keyRotation,
    retention: retained,
    deadLetterRetention: purged,
  };
};
