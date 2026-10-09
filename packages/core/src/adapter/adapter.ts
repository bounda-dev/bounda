import type { Logger } from "../contracts/logger.ts";
import type { FieldsRecord } from "../modules/view.ts";
import type { AdapterDefinition } from "./adapter-definition.ts";
import type { CheckpointStore } from "./storage/checkpoint-store.ts";
import type { DeadLetterStore } from "./storage/dead-letter-store.ts";
import type { EventNotifier } from "./storage/event-notifier.ts";
import type { EventStore } from "./storage/event-store.ts";
import type { InboxLedger } from "./storage/inbox-ledger.ts";
import type { Scheduler } from "./storage/scheduler.ts";
import type { ReadClient, Table } from "./storage/table.ts";

/**
 * The write-side stores bound to one open transaction: what `Storage.transact` runs its
 * work with. What the work writes through them commits together when it resolves and rolls
 * back together when it throws. `eventStore.load` sees the events the work appended; what the
 * other three read back while the transaction is open is the store as committed, or the
 * transaction's own writes, depending on the adapter, so the work must not depend on it.
 */
export interface StorageTransaction {
  readonly eventStore: EventStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
}

/**
 * Everything the write side and the reactive runners need from one storage backend.
 */
export interface Storage {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
  /**
   * Only for a backend that can push new events; without it the dispatcher only polls.
   */
  readonly notifier?: EventNotifier;
  /**
   * Runs `work` in one transaction over the write-side stores: everything it writes through the
   * transaction's stores lands together or not at all. A stale `expectedVersion` on any append
   * rejects with `ConcurrencyError` and rolls the rest back. The work goes through the
   * transaction's stores only: the storage's own may wait on the transaction (a single-writer
   * queue) or write outside it. It must not wait on anything outside the store either: on a
   * single-writer engine the transaction holds the store's only writer.
   */
  transact<T>(work: (transaction: StorageTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * What one read model needs from its storage backend.
 */
export interface ReadModelStorage<Row extends object = Record<string, unknown>, Raw = unknown> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row, Raw>;
  /**
   * The checkpoints of this read model's projections, in the same database as its rows.
   */
  readonly checkpointStore: CheckpointStore;
  /**
   * Runs `work` in one transaction holding the lock named `subscriber`. What it writes through the
   * transaction's `table`, `client` and `checkpointStore` commits when it resolves and rolls back
   * when it throws, all together, so a batch and the checkpoint past it are never apart. When
   * another holder has the lock, `wait: false` resolves at once with `acquired: false`; a database
   * with a single writer may wait regardless.
   */
  transact<T>(args: ReadModelTransactArgs<Row, T>): Promise<ReadModelTransacted<T>>;
  close(): Promise<void>;
}

/**
 * The read model's stores bound to one transaction; `client.raw` is the driver's transaction handle.
 */
export interface ReadModelTransaction<Row extends object = Record<string, unknown>> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row>;
  readonly checkpointStore: CheckpointStore;
}

export interface ReadModelTransactArgs<Row extends object, T> {
  readonly subscriber: string;
  readonly wait: boolean;
  readonly work: (transaction: ReadModelTransaction<Row>) => Promise<T>;
}

export type ReadModelTransacted<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

/**
 * A read model being rebuilt from scratch, next to the live one. Projections write into `table`
 * while queries keep reading the live table; `commit` swaps the two and drops the old one, `abort`
 * drops what was built, `pause` keeps it for a later rebuild with the same `progress`. Each of the
 * three releases the adapter's resources, even when it fails, and only the first to run does: an
 * `abort` after a failed `commit` releases nothing twice. Once a newer rebuild of the read model
 * opens, this one is fenced off as `rebuildFencing` describes.
 */
export interface ReadModelRebuild<Row extends object = Record<string, unknown>, Raw = unknown> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row, Raw>;
  /**
   * Whether `table` is the shadow a paused rebuild left under the same `progress`, rows included,
   * rather than a fresh one.
   */
  readonly resumed: boolean;
  /**
   * The position the shadow holds the events up to: the one saved under `progress` when resumed,
   * 0 for a fresh shadow.
   */
  readonly position: number;
  /**
   * The checkpoints in the read model's database, where `progress` is kept.
   */
  readonly checkpointStore: CheckpointStore;
  /**
   * Runs `work` in one transaction on the shadow, which commits or rolls back as one, so a batch
   * and the progress past it are never apart.
   */
  transact<T>(work: (transaction: ReadModelTransaction<Row>) => Promise<T>): Promise<T>;
  /**
   * In one transaction, holding the lock named `subscriber` as `ReadModelStorage.transact` does:
   * the shadow takes the live table's place, the checkpoint `subscriber` is set to `position`,
   * so the projections carry on from there, and `progress` is forgotten.
   */
  commit(args: CommitReadModelRebuildArgs): Promise<void>;
  /**
   * Drops the shadow and forgets `progress`.
   */
  abort(): Promise<void>;
  pause(): Promise<void>;
}

export interface CommitReadModelRebuildArgs {
  readonly subscriber: string;
  readonly position: number;
}

export interface CreateReadModelRebuildArgs extends CreateReadModelArgs {
  /**
   * The checkpoint the rebuild keeps its position under. The shadow a paused rebuild left is
   * reopened, rows included, when this checkpoint says it got somewhere; otherwise a fresh one
   * replaces it.
   */
  readonly progress: string;
}

export interface CreateStorageArgs {
  readonly logger: Logger;
}

export interface CreateReadModelArgs {
  readonly name: string;
  readonly fields: FieldsRecord;
  readonly logger: Logger;
}

/**
 * A storage adapter, as `sqlite({ path })` returns: the definition `bounda.config.ts` holds plus
 * the factories the kernel calls at boot and when rebuilding a read model.
 */
export interface Adapter<Name extends string = string, Options = unknown>
  extends AdapterDefinition<Name, Options> {
  /**
   * Opens the write side, creating its tables when missing. A factory that throws has released
   * whatever it took: the kernel only closes the stores it was given.
   */
  createStorage(args: CreateStorageArgs): Promise<Storage>;
  /**
   * Opens a read model's table, creating or evolving it from `fields`; throws `ConfigurationError`
   * on a change that needs a rebuild. Releases what it took when it throws, as `createStorage`.
   */
  createReadModel<Row extends object>(args: CreateReadModelArgs): Promise<ReadModelStorage<Row>>;
  /**
   * Opens a shadow of the read model with the current `fields`; the live table stays untouched
   * until `commit`. Releases what it took when it throws, as `createStorage`.
   */
  rebuildReadModel<Row extends object>(
    args: CreateReadModelRebuildArgs,
  ): Promise<ReadModelRebuild<Row>>;
}

export interface IsAdapterFunction {
  (value: unknown): value is Adapter;
}

/**
 * Whether `value` is an `AdapterDefinition` that also carries the three factories.
 */
export const isAdapter: IsAdapterFunction = (value): value is Adapter =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  typeof Reflect.get(value, "createStorage") === "function" &&
  typeof Reflect.get(value, "createReadModel") === "function" &&
  typeof Reflect.get(value, "rebuildReadModel") === "function";
