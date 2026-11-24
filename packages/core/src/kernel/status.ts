import type { Adapter, SchemaScopeName, SchemaVersion } from "../adapter/adapter.ts";
import { isAdapter } from "../adapter/adapter.ts";
import type { FileEncryptionState } from "../adapter/storage/encrypted-file.ts";
import type {
  StoredSubscriberFailure,
  SubscriberFailureStore,
} from "../adapter/storage/subscriber-failure-store.ts";
import type { ResolvedConfig } from "../config/types.ts";
import type { Logger } from "../contracts/logger.ts";
import type { CountryCode, RecipientKind, TransferSafeguard } from "../modules/recipient.ts";
import type { AppLag, PersonalDataBackfillLag } from "./app.ts";
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
import type { UnreadableStatus } from "./shared/retention-status.ts";

/**
 * A scope of Bounda's tables where it lives: `storage`, a read model's database of its own as
 * `readModels.<name>`, `forgetLedger`, or `tenantKeys`.
 */
export interface SchemaStatus extends SchemaVersion {
  readonly database: string;
}

/**
 * A database whose versions could not be read.
 */
export interface UnreadableSchemaStatus extends UnreadableStatus {
  readonly database: string;
}

/**
 * Every subscriber's lag, as `app.getLag()` reports it; the backfill of personal data is
 * `AppStatus`'s own part.
 */
export interface StatusLag extends Omit<AppLag, "personalDataBackfill"> {}

/**
 * A subscriber's last failure without its text, which `subscriberFailures` opens. `current` while
 * the subscriber is still stuck on it, `null` for an unresolved failure while where the subscriber
 * stands could not be read.
 */
export interface SubscriberFailureStatus
  extends Omit<StoredSubscriberFailure, "errorMessage" | "errorStack"> {
  readonly current: boolean | null;
}

/**
 * Where the runtime's background work stands, as the database says: what `bounda status` prints.
 * Nothing in it is personal data, so reading it records nothing in the access log.
 *
 * Never incomplete in silence: a part whose store cannot be read, a database of `schema` or a
 * subscriber of `lag` included, is logged and comes back as `{ unreadable: true }`
 * (`UnreadableStatus`), and the other parts still do; `unreadableParts` names them.
 */
export interface AppStatus {
  /**
   * Every scope of Bounda's tables the app uses, at the version its database holds beside the
   * latest this version of Bounda migrates it to, or the database whose versions could not be
   * read.
   */
  readonly schema: readonly (SchemaStatus | UnreadableSchemaStatus)[];
  /**
   * How many times a running instance found the database gone back to an earlier copy.
   */
  readonly restoresFound: number | UnreadableStatus;
  /**
   * Unreadable as a whole when the stream itself, its head or the events past a checkpoint, could
   * not be read.
   */
  readonly lag: StatusLag | UnreadableStatus;
  readonly subscriberFailures: readonly SubscriberFailureStatus[] | UnreadableStatus;
  /**
   * `null` when no schema marks personal data.
   */
  readonly personalDataBackfill: PersonalDataBackfillLag | null | UnreadableStatus;
  /**
   * `null` without `runtime.personalData.forgetLedger`.
   */
  readonly forgetLedger: ForgetLedgerReconciliationStatus | null | UnreadableStatus;
  /**
   * The tenant the app serves and its key: the version in force, the older ones still held, the
   * master key they are wrapped under, and when the tenant was forgotten. `null` for an app without
   * keys, which marks nothing personal and names none.
   */
  readonly tenant: TenantKeyStatus | null | UnreadableStatus;
  /**
   * Once the tenant is forgotten, whether what its forgetting still needed is gone. `null` while
   * it is not forgotten.
   */
  readonly forgottenTenant: ForgottenTenantStatus | null | UnreadableStatus;
  /**
   * Where the keys under the tenant's key stand as it rotates. `null` for an app without keys,
   * and once the tenant is forgotten.
   */
  readonly keyRotation: KeyRotationStatus | null | UnreadableStatus;
  /**
   * `null` when no schema marks personal data: every retention set, of the app and of each
   * declared category, and the keys kept past a forgetting that no erasure exemption keeps any
   * more.
   */
  readonly retention: RetentionStatus | null | UnreadableStatus;
  /**
   * The purge of resolved dead letters past `runtime.deadLetters.retention`, and the failed ones
   * no handler the app runs would retry; `null` once the tenant is forgotten.
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
  readonly recipients: readonly RecipientStatus[] | UnreadableStatus;
  /**
   * Every database file the app opened under the tenant's keys, and where its encryption stands:
   * one still `"clear"`, or under an `"earlier"` key, is encrypted once no other connection has it
   * open. Empty without such a file.
   */
  readonly files: readonly EncryptedFileStatus[];
}

/**
 * Where a forgotten tenant's last work stands. Once every recipient is told, the forget ledger
 * holds nothing of the tenant, `null` meaning the app has no ledger, and the keys of its encrypted
 * database files are destroyed, nothing Bounda keeps needs the tenant's database any more: it may
 * be deleted.
 */
export interface ForgottenTenantStatus {
  /**
   * Whether every recipient of the tenant's data was told of the forgetting: each notice
   * delivered, or its dead letter retried or discarded.
   */
  readonly recipientsTold: boolean;
  /**
   * Whether the forget ledger holds no entry and no mark of the tenant, which it does once the
   * recipients are told; `null` without `runtime.personalData.forgetLedger`.
   */
  readonly forgetLedgerCleared: boolean | null;
  /**
   * Whether the tenant key store's record holds no key of the tenant's encrypted database files,
   * which it keeps under the master key until the recipients are told, so the notices can read the
   * files; `true` for a tenant without such files.
   */
  readonly fileKeysDestroyed: boolean;
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
  readonly logger: Logger;
  readonly lag: () => Promise<StatusLag>;
  readonly backfill?: (() => Promise<PersonalDataBackfillLag>) | undefined;
  readonly failures: SubscriberFailureStore;
  readonly restores: RestoreWatch;
  readonly reconciliation?: Pick<ForgetLedgerReconciliation, "status"> | undefined;
  readonly rotation?: Pick<KeyRotation, "status"> | undefined;
  readonly tenant?: (() => Promise<TenantKeyStatus>) | undefined;
  readonly forgottenTenant?: (() => Promise<ForgottenTenantStatus>) | undefined;
  readonly retention?: Pick<RetentionSweep, "status"> | undefined;
  readonly letterRetention?: Pick<DeadLetterRetention, "status"> | undefined;
  readonly failureRetention?: Pick<SubscriberFailureRetention, "status"> | undefined;
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

const UNREADABLE: UnreadableStatus = { unreadable: true };

export interface IsUnreadableFunction {
  (part: unknown): part is UnreadableStatus;
}

/**
 * Whether a part of `app.status()` came back unreadable, as `{ unreadable: true }`: what narrows
 * a part before reading it, `restoresFound` included.
 */
export const isUnreadable: IsUnreadableFunction = (part): part is UnreadableStatus =>
  typeof part === "object" && part !== null && "unreadable" in part;

interface ReadablePartFunction {
  <T>(part: string, read: () => Promise<T>): Promise<T | UnreadableStatus>;
}

export const readAppStatus: ReadAppStatusFunction = async ({
  config,
  logger,
  lag,
  backfill,
  failures,
  restores,
  reconciliation,
  rotation,
  tenant,
  forgottenTenant,
  retention,
  letterRetention,
  failureRetention,
  recipients,
}) => {
  const readable: ReadablePartFunction = async (part, read) => {
    try {
      return await read();
    } catch (error) {
      logger.error("a part of the status could not be read", { part, error });
      return UNREADABLE;
    }
  };
  const databases = databasesOf(config);
  const [
    schema,
    restoresFound,
    current,
    stored,
    personalDataBackfill,
    forgetLedger,
    keyRotation,
    tenantKey,
    forgotten,
    retained,
    purged,
    expired,
    told,
  ] = await Promise.all([
    Promise.all(
      databases.map(async (database) => {
        try {
          return schemaOf(database, await database.adapter.schemaVersions());
        } catch (error) {
          logger.error("a part of the status could not be read", {
            part: "schema",
            database: database.database,
            error,
          });
          return [{ database: database.database, unreadable: true as const }];
        }
      }),
    ).then((all) => all.flat()),
    readable("restoresFound", () => restores.found()),
    readable("lag", lag),
    readable("subscriberFailures", () => failures.list()),
    readable("personalDataBackfill", async () => (await backfill?.()) ?? null),
    readable("forgetLedger", async () => (await reconciliation?.status()) ?? null),
    readable("keyRotation", async () => (await rotation?.status()) ?? null),
    readable("tenant", async () => (await tenant?.()) ?? null),
    readable("forgottenTenant", async () => (await forgottenTenant?.()) ?? null),
    readable("retention", async () => (await retention?.status()) ?? null),
    letterRetention?.status() ?? null,
    failureRetention?.status() ?? null,
    readable("recipients", async () => (await recipients?.()) ?? []),
  ]);
  // `null` for a subscriber whose position could not be read, as for every one without the lag.
  const positions = isUnreadable(current)
    ? undefined
    : new Map(
        current.subscribers.map((each) => [
          each.subscriber,
          isUnreadable(each) ? null : each.position,
        ]),
      );
  const positionOf = (subscriber: string): number | null | undefined =>
    positions === undefined ? null : positions.get(subscriber);
  return {
    schema,
    restoresFound,
    lag: current,
    // A subscriber the app no longer runs is stuck on nothing; one whose position could not be
    // read may be.
    subscriberFailures: isUnreadable(stored)
      ? stored
      : stored.map(({ errorMessage: _message, errorStack: _stack, ...failure }) => {
          const position = positionOf(failure.subscriber);
          return {
            ...failure,
            current:
              failure.resolvedAt !== null || position === undefined
                ? false
                : position === null
                  ? null
                  : position < failure.position,
          };
        }),
    personalDataBackfill,
    forgetLedger,
    tenant: tenantKey,
    forgottenTenant: forgotten,
    keyRotation,
    retention: retained,
    deadLetterRetention: purged,
    subscriberFailureRetention: expired,
    recipients: told,
    files: databases.flatMap(({ database, adapter }) =>
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

export interface UnreadablePartsFunction {
  (status: AppStatus): readonly string[];
}

const PARTS = [
  "schema",
  "restoresFound",
  "lag",
  "subscriberFailures",
  "personalDataBackfill",
  "forgetLedger",
  "tenant",
  "forgottenTenant",
  "keyRotation",
  "retention",
  "deadLetterRetention",
  "subscriberFailureRetention",
  "recipients",
] as const satisfies readonly (keyof AppStatus)[];

/**
 * The parts of `status` that could not be read, in the order of its fields, as the logs name them:
 * a field of `AppStatus`, `schema` with its database, as `schema (readModels.audit)`, and `lag`
 * with its subscriber, as `lag (projection:customers)`, unless the lag could not be read at all.
 * Empty when every part was read: what a host or a script checks before taking the status as
 * complete.
 */
export const unreadableParts: UnreadablePartsFunction = (status) =>
  PARTS.flatMap((part) => {
    if (part === "schema") {
      return status.schema.flatMap((each) =>
        isUnreadable(each) ? [`schema (${each.database})`] : [],
      );
    }
    if (part === "lag" && !isUnreadable(status.lag)) {
      return status.lag.subscribers.flatMap((each) =>
        isUnreadable(each) ? [`lag (${each.subscriber})`] : [],
      );
    }
    return isUnreadable(status[part]) ? [part] : [];
  });
