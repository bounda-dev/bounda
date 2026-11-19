import type { StorageTransaction } from "./adapter.ts";
import type { NewDeadLetter, StoredDeadLetter } from "./storage/dead-letter-store.ts";
import { erased, type IdempotencyRecord } from "./storage/idempotency-store.ts";
import { pageByKey } from "./storage/person-page.ts";
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
  readonly idempotencyStore: Pick<
    DeferredStores["idempotencyStore"],
    "put" | "forget" | "erase" | "reseal"
  >;
}

/**
 * The stores with their writes held back: `stores` answer reads from `live` at once and record
 * every write in order, and `flush` runs the writes recorded so far against another set of the
 * same stores, a transaction's or the live ones. `add` answers the letter as filed, whatever the
 * store holds under that id already; `get` and `listByPerson` on the idempotency store answer a
 * record `put` recorded before anything `live` holds, as its writes since left it. `tryClaim`,
 * `claimDue`, both `renew`, both `purge`, the `forget` of the scheduler and the dead letter store,
 * `removeHeld` and both `clear` act at once, on `live`, since their answer decides what happens
 * next.
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
  // `null` for a record filed elsewhere, gone from its key.
  const records = new Map<string, IdempotencyRecord | null>();
  const held = (): IdempotencyRecord[] =>
    [...records.values()].filter((record): record is IdempotencyRecord => record !== null);
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
        firstHeldAt: deadLetterStore.firstHeldAt,
        purge: deadLetterStore.purge,
        listHeld: deadLetterStore.listHeld,
        failedByHandler: deadLetterStore.failedByHandler,
        removeHeld: deadLetterStore.removeHeld,
        clear: async (keepEventId) => {
          for (const [id, { eventId }] of letters) {
            if (eventId === keepEventId) continue;
            letters.delete(id);
            recorded.push((target) => target.deadLetterStore.remove(id));
          }
          await deadLetterStore.clear(keepEventId);
        },
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
        get: scheduler.get,
        listByPerson: scheduler.listByPerson,
        forget: scheduler.forget,
      },
      idempotencyStore: {
        get: async (args) =>
          records.has(args.key) ? (records.get(args.key) ?? null) : idempotencyStore.get(args),
        put: async (args) => {
          const { now: _now, ...record } = args;
          records.set(record.key, record);
          recorded.push((target) => target.idempotencyStore.put(args));
        },
        listByPerson: async function listByPerson(args): Promise<readonly IdempotencyRecord[]> {
          const live = await idempotencyStore.listByPerson(args);
          // A full page ends at its last key: what `put` recorded past it belongs to a later page.
          const until = live.length === args.limit ? live.at(-1)?.key : undefined;
          const page = pageByKey(
            [
              ...held().filter(
                (record) =>
                  new Date(record.expiresAt).getTime() > args.now.getTime() &&
                  namesPerson(record, args.person) &&
                  (until === undefined || record.key <= until),
              ),
              ...live.filter(({ key }) => !records.has(key)),
            ],
            ({ key }) => key,
            args,
          );
          // Every record of a full page was replaced here: the next page may still hold some.
          return page.length === 0 && until !== undefined
            ? listByPerson({ ...args, after: until })
            : page;
        },
        list: async (args) => {
          const now = args.now.getTime();
          const merged = new Map(
            (await idempotencyStore.list({ now: args.now })).map((record) => [record.key, record]),
          );
          for (const [key, record] of records) {
            if (record !== null && new Date(record.expiresAt).getTime() > now) {
              merged.set(key, record);
            } else merged.delete(key);
          }
          const offset = args.offset ?? 0;
          const { after } = args;
          return [...merged.values()]
            .filter(({ key }) => after === undefined || key > after)
            .sort((a, b) => (a.key < b.key ? -1 : 1))
            .slice(offset, args.limit === undefined ? undefined : offset + args.limit);
        },
        erase: async (args) => {
          const { key, filed = key, now } = args;
          const live = async (at: string): Promise<IdempotencyRecord | null> => {
            const found = records.has(at)
              ? (records.get(at) ?? null)
              : await idempotencyStore.get({ key: at, now });
            return found === null || new Date(found.expiresAt).getTime() <= now.getTime()
              ? null
              : found;
          };
          const record = await live(key);
          if (record === null) return;
          const existing = await live(filed);
          if (filed !== key) records.set(key, null);
          if (filed === key || existing === null)
            records.set(filed, erased({ ...record, key: filed }));
          recorded.push((target) => target.idempotencyStore.erase(args));
        },
        reseal: async (args) => {
          const record = records.has(args.key) ? (records.get(args.key) ?? null) : undefined;
          if (
            record !== undefined &&
            record !== null &&
            JSON.stringify(record.answer) === JSON.stringify(args.from)
          ) {
            records.set(args.key, { ...record, answer: args.answer, persons: args.persons });
          }
          recorded.push((target) => target.idempotencyStore.reseal(args));
        },
        purge: idempotencyStore.purge,
        clear: async () => {
          records.clear();
          await idempotencyStore.clear();
        },
        forget: async (person, keep) => {
          for (const [key, record] of records) {
            if (record !== null && namesPerson(record, person, keep)) {
              records.set(key, erased(record));
            }
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
