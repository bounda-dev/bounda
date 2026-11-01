import type { StorageTransaction } from "./adapter.ts";
import type { IdempotencyRecord } from "./storage/idempotency-store.ts";

/**
 * The write-side stores besides the event store.
 */
export type DeferredStores = Pick<
  StorageTransaction,
  "inboxLedger" | "deadLetterStore" | "scheduler" | "idempotencyStore"
>;

export interface DeferredWriteTarget {
  readonly inboxLedger: Pick<DeferredStores["inboxLedger"], "complete" | "fail">;
  readonly deadLetterStore: Pick<
    DeferredStores["deadLetterStore"],
    "add" | "updateStatus" | "remove"
  >;
  readonly scheduler: Pick<
    DeferredStores["scheduler"],
    "schedule" | "cancel" | "complete" | "fail" | "defer"
  >;
  readonly idempotencyStore: Pick<DeferredStores["idempotencyStore"], "put" | "forget">;
}

/**
 * The stores with their writes held back: `stores` answer reads from `live` at once and record
 * every write in order, and `flush` runs the writes recorded so far against another set of the
 * same stores, a transaction's or the live ones. `add` answers the letter as filed, whatever the
 * store holds under that id already; `get` on the idempotency store answers a record `put`
 * recorded before anything `live` holds. `tryClaim`, `claimDue`, both `renew`, `purge` and the
 * `forget` of the scheduler and the dead letter store act at once, on `live`, since their answer
 * decides what happens next.
 */
export interface DeferredWrites {
  readonly stores: DeferredStores;
  flush(target: DeferredWriteTarget): Promise<void>;
  /**
   * Whether any write is recorded and not flushed yet.
   */
  pending(): boolean;
}

export interface DeferWritesFunction {
  (live: DeferredStores): DeferredWrites;
}

type Recorded = (target: DeferredWriteTarget) => Promise<unknown>;

export const deferWrites: DeferWritesFunction = ({
  inboxLedger,
  deadLetterStore,
  scheduler,
  idempotencyStore,
}) => {
  const recorded: Recorded[] = [];
  const records = new Map<string, IdempotencyRecord>();
  const later =
    <Args extends unknown[]>(
      write: (target: DeferredWriteTarget, ...args: Args) => Promise<unknown>,
    ) =>
    async (...args: Args): Promise<void> => {
      recorded.push((target) => write(target, ...args));
    };
  return {
    stores: {
      inboxLedger: {
        tryClaim: inboxLedger.tryClaim,
        get: inboxLedger.get,
        complete: later((target, args) => target.inboxLedger.complete(args)),
        fail: later((target, args) => target.inboxLedger.fail(args)),
        renew: inboxLedger.renew,
      },
      deadLetterStore: {
        get: deadLetterStore.get,
        list: deadLetterStore.list,
        count: deadLetterStore.count,
        add: async (letter) => {
          recorded.push((target) => target.deadLetterStore.add(letter));
          return { ...letter, status: "failed" };
        },
        updateStatus: later((target, id, status) =>
          target.deadLetterStore.updateStatus(id, status),
        ),
        remove: later((target, id) => target.deadLetterStore.remove(id)),
        forget: deadLetterStore.forget,
      },
      scheduler: {
        claimDue: scheduler.claimDue,
        nextDueAt: scheduler.nextDueAt,
        list: scheduler.list,
        schedule: later((target, args) => target.scheduler.schedule(args)),
        cancel: later((target, key) => target.scheduler.cancel(key)),
        complete: later((target, claim) => target.scheduler.complete(claim)),
        fail: later((target, args) => target.scheduler.fail(args)),
        defer: later((target, args) => target.scheduler.defer(args)),
        renew: scheduler.renew,
        forget: scheduler.forget,
      },
      idempotencyStore: {
        get: async (args) => records.get(args.key) ?? idempotencyStore.get(args),
        put: async (args) => {
          const { now: _now, ...record } = args;
          records.set(record.key, record);
          recorded.push((target) => target.idempotencyStore.put(args));
        },
        purge: idempotencyStore.purge,
        forget: async (person) => {
          for (const [key, record] of records) {
            if (record.persons.some((held) => held.person === person)) records.delete(key);
          }
          recorded.push((target) => target.idempotencyStore.forget(person));
        },
      },
    },
    flush: async (target) => {
      for (const write of recorded) await write(target);
    },
    pending: () => recorded.length > 0,
  };
};
