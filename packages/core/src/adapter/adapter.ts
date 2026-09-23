import type { Logger } from "../contracts/logger.ts";
import type { FieldsRecord } from "../modules/view.ts";
import type { AdapterDefinition } from "./adapter-definition.ts";
import type { CheckpointStore } from "./ports/checkpoint-store.ts";
import type { DeadLetterStore } from "./ports/dead-letter-store.ts";
import type { EventNotifier } from "./ports/event-notifier.ts";
import type { EventStore } from "./ports/event-store.ts";
import type { InboxLedger } from "./ports/inbox-ledger.ts";
import type { Scheduler } from "./ports/scheduler.ts";
import type { ReadClient, Table } from "./ports/table.ts";

/**
 * Everything the write side and the reactive runners need from one storage backend.
 */
export interface StoragePorts {
  readonly eventStore: EventStore;
  readonly checkpointStore: CheckpointStore;
  readonly inboxLedger: InboxLedger;
  readonly deadLetterStore: DeadLetterStore;
  readonly scheduler: Scheduler;
  /**
   * Present when the backend can push "new events" to the dispatcher; absent when it can only
   * be polled.
   */
  readonly notifier?: EventNotifier;
  close(): Promise<void>;
}

/**
 * What one read model needs from its storage backend.
 */
export interface ReadModelPorts<Row extends object = Record<string, unknown>, Raw = unknown> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row, Raw>;
  /**
   * The checkpoints of this read model's projections, in the same database as its rows.
   */
  readonly checkpointStore: CheckpointStore;
  /**
   * Runs `work` in one transaction on the read model's database, holding the lock named
   * `subscriber` for its whole length. What `work` writes through the transaction's `table`,
   * `client` and `checkpointStore` commits together when it resolves and rolls back together when
   * it throws, so a batch and the checkpoint past it are never apart. When another holder has the
   * lock, `wait` decides between waiting for it and resolving at once with `acquired: false`.
   */
  transact<T>(args: ReadModelTransactArgs<Row, T>): Promise<ReadModelTransacted<T>>;
  close(): Promise<void>;
}

/**
 * What `ReadModelPorts.transact` runs its work with: the read model's table, client and
 * checkpoints, all bound to the one transaction. `client.raw` is the driver's transaction handle.
 */
export interface ReadModelTransaction<Row extends object = Record<string, unknown>> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row>;
  readonly checkpointStore: CheckpointStore;
}

export interface ReadModelTransactArgs<Row extends object, T> {
  /**
   * The subscriber the transaction is for; its name is the lock's.
   */
  readonly subscriber: string;
  /**
   * Wait for the lock when someone else holds it, instead of giving up.
   */
  readonly wait: boolean;
  readonly work: (transaction: ReadModelTransaction<Row>) => Promise<T>;
}

/**
 * The outcome of `ReadModelPorts.transact`: the work's result, or `acquired: false` when the lock
 * was taken and the caller chose not to wait.
 */
export type ReadModelTransacted<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

/**
 * A read model being rebuilt from scratch, next to the live one. Projections write into `table`
 * while queries keep reading the live table; `commit` swaps the two and drops the old one, `abort`
 * drops what was built, `pause` keeps it for a later rebuild with the same `progress`. Each of the
 * three releases the adapter's resources.
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
   * Runs `work` in one transaction on the shadow: what it writes through the transaction's
   * `table`, `client` and `checkpointStore` commits together or rolls back together, so a batch
   * and the progress past it are never apart.
   */
  transact<T>(work: (transaction: ReadModelTransaction<Row>) => Promise<T>): Promise<T>;
  /**
   * In one transaction, holding the lock named `subscriber` as `ReadModelPorts.transact` does:
   * the shadow takes the live table's place, the checkpoint `subscriber` is set to `position` and
   * `progress` is forgotten. The read model then holds the events up to `position` exactly, and
   * its projections carry on from there.
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
   * The checkpoint the rebuild keeps its position under. A shadow left by a paused rebuild is
   * reopened, rows included, when this checkpoint says it got somewhere; otherwise it is
   * discarded and a fresh one opened.
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
 * A storage adapter: the definition users put in `bounda.config.ts` plus the factories the kernel
 * calls at boot and when rebuilding a read model. `sqlite({ path })` returns one of these.
 */
export interface Adapter<Name extends string = string, Options = unknown>
  extends AdapterDefinition<Name, Options> {
  createStorage(args: CreateStorageArgs): Promise<StoragePorts>;
  createReadModel<Row extends object>(args: CreateReadModelArgs): Promise<ReadModelPorts<Row>>;
  /**
   * Opens a shadow table for `name` with the current `fields`, leaving the live table untouched
   * until `commit`: the one a paused rebuild left under the same `progress`, or a fresh one.
   */
  rebuildReadModel<Row extends object>(
    args: CreateReadModelRebuildArgs,
  ): Promise<ReadModelRebuild<Row>>;
}

export interface IsAdapterFunction {
  (value: unknown): value is Adapter;
}

/**
 * Runtime check used at boot: a definition that also carries the factories.
 */
export const isAdapter: IsAdapterFunction = (value): value is Adapter =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "bounda-adapter" &&
  typeof Reflect.get(value, "createStorage") === "function" &&
  typeof Reflect.get(value, "createReadModel") === "function" &&
  typeof Reflect.get(value, "rebuildReadModel") === "function";
