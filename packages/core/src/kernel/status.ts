import type { Adapter, SchemaScopeName, SchemaVersion } from "../adapter/adapter.ts";
import { isAdapter } from "../adapter/adapter.ts";
import type { FileEncryptionState } from "../adapter/storage/encrypted-file.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../adapter/storage/subscriber-failure-store.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { CountryCode, RecipientKind, TransferSafeguard } from "../modules/recipient.ts";
import type { AppLag } from "./app.ts";
import type { DeadLetterRetention, DeadLetterRetentionStatus } from "./dead-letters/retention.ts";
import type {
  SubscriberFailureRetention,
  SubscriberFailureRetentionStatus,
} from "./dispatch/failure-retention.ts";
import { sharesStorage } from "./personal-data/forget-ledger.ts";
import type {
  ForgetLedgerReconciliation,
  ForgetLedgerReconciliationStatus,
} from "./personal-data/reconciliation.ts";
import type { RetentionStatus, RetentionSweep } from "./personal-data/retention.ts";
import type { KeyRotation, KeyRotationStatus } from "./personal-data/rotation.ts";
import type { TenantKeyStatus } from "./personal-data/tenant-keys.ts";
import type { RestoreWatch } from "./shared/restores.ts";

/**
 * A scope of Bounda's tables where it lives: `storage`, a read model's database of its own as
 * `readModels.<name>`, `forgetLedger`, or `tenantKeys`.
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
   * The tenant the app serves and its key: the version in force, the older ones still held, the
   * master key they are wrapped under, and when the tenant was forgotten. `null` for an app without
   * keys, which marks nothing personal and names none.
   */
  readonly tenant: TenantKeyStatus | null;
  /**
   * Where the keys under the tenant's key stand as it rotates. `null` for an app without keys,
   * and once the tenant is forgotten.
   */
  readonly keyRotation: KeyRotationStatus | null;
  /**
   * `null` when no schema marks personal data: every retention set, of the app and of each
   * declared category, and the keys kept past a forgetting that no erasure exemption keeps any
   * more.
   */
  readonly retention: RetentionStatus | null;
  /**
   * `null` without `runtime.deadLetters.retention`.
   */
  readonly deadLetterRetention: DeadLetterRetentionStatus | null;
  /**
   * The purge of subscriber failures past `runtime.subscriberFailures.retention`; `null` once the
   * tenant is forgotten, which removed them all.
   */
  readonly subscriberFailureRetention: SubscriberFailureRetentionStatus | null;
  /**
   * Every recipient the app declares or the store remembers data went to, by port.
   */
  readonly recipients: readonly RecipientStatus[];
  /**
   * Every database file the app opened under the tenant's keys, and where its encryption stands:
   * one still `"clear"`, or under an `"earlier"` key, is encrypted once no other connection has it
   * open. Empty without such a file.
   */
  readonly files: readonly EncryptedFileStatus[];
}

/**
 * A database file opened under the tenant's keys: the database of the configuration it holds, the
 * file, and where its encryption stands.
 */
export interface EncryptedFileStatus {
  readonly database: string;
  readonly file: string;
  readonly state: FileEncryptionState;
}

/**
 * Where a recipient stands: who it is, as its port declares it now, `null` for a port the app no
 * longer declares; how many persons the store recorded as disclosed to it; whether it is still
 * being told what was recorded before it was declared; and how many of its notices wait as failed
 * dead letters.
 */
export interface RecipientStatus {
  readonly port: string;
  readonly declared: {
    readonly name: string;
    readonly kind: RecipientKind;
    readonly country: CountryCode;
    readonly safeguard: TransferSafeguard | null;
    readonly categories: readonly string[];
  } | null;
  readonly persons: number;
  readonly catchingUp: boolean;
  readonly failedNotices: number;
}

export interface ReadAppStatusArgs {
  readonly config: ResolvedConfig;
  readonly lag: () => Promise<AppLag>;
  readonly failures: SubscriberFailureStore;
  readonly restores: RestoreWatch;
  readonly reconciliation?: ForgetLedgerReconciliation | undefined;
  readonly rotation?: KeyRotation | undefined;
  readonly tenant?: (() => Promise<TenantKeyStatus>) | undefined;
  readonly retention?: RetentionSweep | undefined;
  readonly letterRetention?: DeadLetterRetention | undefined;
  readonly failureRetention?: SubscriberFailureRetention | undefined;
  readonly recipients?: (() => Promise<readonly RecipientStatus[]>) | undefined;
}

export interface ReadAppStatusFunction {
  (args: ReadAppStatusArgs): Promise<AppStatus>;
}

export interface Database {
  readonly database: string;
  readonly adapter: Adapter;
  readonly scopes: readonly SchemaScopeName[];
}

export interface DatabasesOfFunction {
  (config: ResolvedConfig): readonly Database[];
}

// Each database the configuration names, once, with the scopes it keeps there.
export const databasesOf: DatabasesOfFunction = (config) => {
  const databases: Database[] = [];
  if (isAdapter(config.storage)) {
    databases.push({
      database: "storage",
      adapter: config.storage,
      scopes: ["storage", "checkpoints"],
    });
  }
  for (const [name, adapter] of Object.entries(config.readModels)) {
    if (!isAdapter(adapter) || databases.some((known) => sharesStorage(adapter, known.adapter))) {
      continue;
    }
    databases.push({ database: `readModels.${name}`, adapter, scopes: ["checkpoints"] });
  }
  const ledger = config.runtime.personalData.forgetLedger?.store;
  if (isAdapter(ledger)) {
    databases.push({ database: "forgetLedger", adapter: ledger, scopes: ["forget-ledger"] });
  }
  const tenantKeys = config.runtime.personalData.tenantKeys;
  if (isAdapter(tenantKeys)) {
    const shared = databases.find((known) => sharesStorage(tenantKeys, known.adapter));
    if (shared === undefined) {
      databases.push({ database: "tenantKeys", adapter: tenantKeys, scopes: ["tenant-keys"] });
    } else {
      databases[databases.indexOf(shared)] = {
        ...shared,
        scopes: [...shared.scopes, "tenant-keys"],
      };
    }
  }
  return databases;
};

export interface SchemaOfFunction {
  (database: Database, versions: readonly SchemaVersion[]): SchemaStatus[];
}

// The versions of the scopes the database keeps, named after it.
export const schemaOf: SchemaOfFunction = ({ database, scopes }, versions) =>
  versions
    .filter(({ scope }) => (scopes as readonly string[]).includes(scope))
    .map((version) => ({ database, ...version }));

export const readAppStatus: ReadAppStatusFunction = async ({
  config,
  lag,
  failures,
  restores,
  reconciliation,
  rotation,
  tenant,
  retention,
  letterRetention,
  failureRetention,
  recipients,
}) => {
  const [
    schema,
    restoresFound,
    current,
    stored,
    forgetLedger,
    keyRotation,
    tenantKey,
    retained,
    purged,
    expired,
    told,
  ] = await Promise.all([
    Promise.all(
      databasesOf(config).map(async (database) =>
        schemaOf(database, await database.adapter.schemaVersions()),
      ),
    ).then((all) => all.flat()),
    restores.found(),
    lag(),
    failures.list(),
    reconciliation?.status() ?? null,
    rotation?.status() ?? null,
    tenant?.() ?? null,
    retention?.status() ?? null,
    letterRetention?.status() ?? null,
    failureRetention?.status() ?? null,
    recipients?.() ?? [],
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
    personalDataBackfill: current.personalDataBackfill,
    forgetLedger,
    tenant: tenantKey,
    keyRotation,
    retention: retained,
    deadLetterRetention: purged,
    subscriberFailureRetention: expired,
    recipients: told,
    files: databasesOf(config).flatMap(({ database, adapter }) =>
      adapter.fileEncryption === undefined
        ? []
        : [
            {
              database,
              file: adapter.fileEncryption.database,
              state: adapter.fileEncryption.state(),
            },
          ],
    ),
  };
};
