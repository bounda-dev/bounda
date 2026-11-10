import type { StorageTransaction } from "./adapter.ts";
import type { NewDeadLetter, StoredDeadLetter } from "./storage/dead-letter-store.ts";
import type { IdempotencyRecord } from "./storage/idempotency-store.ts";
import { namesPerson } from "./storage/personal-key-store.ts";
import type { ScheduleArgs, ScheduledCommand } from "./storage/scheduler.ts";

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
    "add" | "updateStatus" | "remove" | "reseal"
  >;
  readonly scheduler: Pick<
    DeferredStores["scheduler"],
    "schedule" | "cancel" | "complete" | "fail" | "defer" | "reseal"
  >;
  readonly idempotencyStore: Pick<DeferredStores["idempotencyStore"], "put" | "forget">;
}

/**
 * The stores with their writes held back: `stores` answer reads from `live` at once and record
 * every write in order, and `flush` runs the writes recorded so far against another set of the
 * same stores, a transaction's or the live ones. `add` answers the letter as filed, whatever the
 * store holds under that id already; `get` on the idempotency store answers a record `put`
 * recorded before anything `live` holds. `tryClaim`, `claimDue`, both `renew`, both `purge` and the
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
  /**
   * Withdraws the commands scheduled so far, and not flushed, whose `persons` names `person` as
   * `namesPerson` tells with `keep`, and resolves to them as the scheduler would hold them: what a `forget` that runs before the flush
   * must find too, as it does in a store whose transaction sees its own writes.
   */
  withdrawScheduled(person: string, keep?: readonly string[]): readonly ScheduledCommand[];
  /**
   * The same for the dead letters added so far.
   */
  withdrawLetters(person: string, keep?: readonly string[]): readonly StoredDeadLetter[];
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
  const scheduled = new Map<string, ScheduleArgs>();
  const letters = new Map<string, NewDeadLetter>();
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
        listFailed: deadLetterStore.listFailed,
        add: async (letter) => {
          letters.set(letter.id, letter);
          recorded.push((target) => target.deadLetterStore.add(letter));
          return { ...letter, status: "failed" };
        },
        updateStatus: later((target, id, status, at) =>
          target.deadLetterStore.updateStatus(id, status, at),
        ),
        remove: async (id) => {
          letters.delete(id);
          recorded.push((target) => target.deadLetterStore.remove(id));
        },
        reseal: later((target, id, letter) => target.deadLetterStore.reseal(id, letter)),
        listByPerson: deadLetterStore.listByPerson,
        forget: deadLetterStore.forget,
        firstResolvedAt: deadLetterStore.firstResolvedAt,
        purge: deadLetterStore.purge,
      },
      scheduler: {
        claimDue: scheduler.claimDue,
        nextDueAt: scheduler.nextDueAt,
        list: scheduler.list,
        schedule: async (args) => {
          scheduled.set(args.dedupeKey, args);
          recorded.push((target) => target.scheduler.schedule(args));
        },
        cancel: async (key) => {
          scheduled.delete(key);
          recorded.push((target) => target.scheduler.cancel(key));
        },
        complete: later((target, claim) => target.scheduler.complete(claim)),
        fail: later((target, args) => target.scheduler.fail(args)),
        defer: later((target, args) => target.scheduler.defer(args)),
        reseal: later((target, args) => target.scheduler.reseal(args)),
        renew: scheduler.renew,
        listByPerson: scheduler.listByPerson,
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
        forget: async (person, keep) => {
          for (const [key, record] of records) {
            if (namesPerson(record, person, keep)) records.delete(key);
          }
          recorded.push((target) => target.idempotencyStore.forget(person, keep));
        },
      },
    },
    flush: async (target) => {
      for (const write of recorded) await write(target);
    },
    pending: () => recorded.length > 0,
    withdrawScheduled: (person, keep) => {
      const named = [...scheduled.values()].filter((args) => namesPerson(args, person, keep));
      for (const { dedupeKey } of named) {
        scheduled.delete(dedupeKey);
        recorded.push((target) => target.scheduler.cancel(dedupeKey));
      }
      return named.map(({ dedupeKey, command, executeAt, context, persons }) => ({
        dedupeKey,
        command,
        executeAt: executeAt.toISOString(),
        context,
        attempts: 0,
        persons: persons ?? [],
      }));
    },
    withdrawLetters: (person, keep) => {
      const named = [...letters.values()].filter((letter) => namesPerson(letter, person, keep));
      for (const { id } of named) {
        letters.delete(id);
        recorded.push((target) => target.deadLetterStore.remove(id));
      }
      return named.map((letter) => ({ ...letter, status: "failed" as const }));
    },
  };
};
