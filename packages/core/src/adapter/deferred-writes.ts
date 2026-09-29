import type { StorageTransaction } from "./adapter.ts";

/**
 * The write-side stores besides the event store.
 */
export type DeferredStores = Pick<
  StorageTransaction,
  "inboxLedger" | "deadLetterStore" | "scheduler"
>;

/**
 * The stores with their writes held back: `ports` answer reads from `live` at once and record
 * every write in order, and `flush` runs the writes recorded so far against another set of the
 * same stores, a transaction's or the live ones. `add` answers the letter as filed, whatever the
 * store holds under that id already. `tryClaim` and `claimDue` answer at once, from `live`, since
 * their answer decides what happens next.
 */
export interface DeferredWrites {
  readonly ports: DeferredStores;
  flush(target: DeferredStores): Promise<void>;
  /**
   * Whether any write is recorded and not flushed yet.
   */
  pending(): boolean;
}

export interface DeferWritesFunction {
  (live: DeferredStores): DeferredWrites;
}

type Recorded = (target: DeferredStores) => Promise<unknown>;

export const deferWrites: DeferWritesFunction = ({ inboxLedger, deadLetterStore, scheduler }) => {
  const recorded: Recorded[] = [];
  const later =
    <Args extends unknown[]>(write: (target: DeferredStores, ...args: Args) => Promise<unknown>) =>
    async (...args: Args): Promise<void> => {
      recorded.push((target) => write(target, ...args));
    };
  return {
    ports: {
      inboxLedger: {
        tryClaim: inboxLedger.tryClaim,
        get: inboxLedger.get,
        complete: later((target, args) => target.inboxLedger.complete(args)),
        fail: later((target, args) => target.inboxLedger.fail(args)),
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
      },
    },
    flush: async (target) => {
      for (const write of recorded) await write(target);
    },
    pending: () => recorded.length > 0,
  };
};
