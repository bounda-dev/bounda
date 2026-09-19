import type { Logger } from "../contracts/logger.ts";
import type { FieldsRecord } from "../modules/view.ts";
import type { AdapterDefinition } from "./adapter-definition.ts";
import type { CheckpointStore } from "./ports/checkpoint-store.ts";
import type { DeadLetterStore } from "./ports/dead-letter-store.ts";
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
  close(): Promise<void>;
}

/**
 * What one read model needs from its storage backend.
 */
export interface ReadModelPorts<Row extends object = Record<string, unknown>, Raw = unknown> {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row, Raw>;
  close(): Promise<void>;
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
 * calls at boot. `sqlite({ path })` returns one of these.
 */
export interface Adapter<Name extends string = string, Options = unknown>
  extends AdapterDefinition<Name, Options> {
  createStorage(args: CreateStorageArgs): Promise<StoragePorts>;
  createReadModel<Row extends object>(args: CreateReadModelArgs): Promise<ReadModelPorts<Row>>;
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
  typeof Reflect.get(value, "createReadModel") === "function";
