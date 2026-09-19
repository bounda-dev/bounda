import type { Adapter, CreateReadModelArgs } from "../adapter/adapter.ts";
import { createMemoryCheckpointStore } from "./checkpoint-store.ts";
import { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
import { createMemoryEventStore } from "./event-store.ts";
import { createMemoryInboxLedger } from "./inbox-ledger.ts";
import { createMemoryScheduler } from "./scheduler.ts";
import { createMemoryReadClient, createMemoryTable } from "./table.ts";

/**
 * Options of the in-memory adapter. It has none; the object exists so the factory reads like the
 * others.
 */
export type MemoryOptions = Record<never, never>;

export type MemoryAdapter = Adapter<"memory", MemoryOptions>;

export interface MemoryFunction {
  (options?: MemoryOptions): MemoryAdapter;
}

/**
 * The in-memory storage adapter: every port backed by maps, gone when the process ends. For
 * tests and for trying Bounda without a database. Each call returns an adapter with its own
 * isolated storage.
 */
export const memory: MemoryFunction = (options = {}) => ({
  kind: "bounda-adapter",
  name: "memory",
  options,
  createStorage: async () => ({
    eventStore: createMemoryEventStore(),
    checkpointStore: createMemoryCheckpointStore(),
    inboxLedger: createMemoryInboxLedger(),
    deadLetterStore: createMemoryDeadLetterStore(),
    scheduler: createMemoryScheduler(),
    close: async () => {},
  }),
  createReadModel: async <Row extends object>({ name, fields }: CreateReadModelArgs) => {
    const table = createMemoryTable<Row>({ name, fields });
    return { table, client: createMemoryReadClient({ name, table }), close: async () => {} };
  },
});

export { createMemoryCheckpointStore } from "./checkpoint-store.ts";
export { createMemoryDeadLetterStore } from "./dead-letter-store.ts";
export { createMemoryEventStore } from "./event-store.ts";
export { createMemoryInboxLedger } from "./inbox-ledger.ts";
export { createMemoryScheduler } from "./scheduler.ts";
export type { CreateMemoryTableArgs } from "./table.ts";
export { createMemoryReadClient, createMemoryTable } from "./table.ts";
