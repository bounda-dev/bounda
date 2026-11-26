import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
  type ForgetLedgerMark,
  type PruneForgetLedgerArgs,
  type ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { resolveConfig } from "../../config/schema.ts";
import type { Config } from "../../config/types.ts";
import { createFixedClock, type FixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { isSealed } from "../personal-data/crypto.ts";
import { createEphemeralKeys } from "../personal-data/ephemeral-keys.ts";
import { defineForgetLedger } from "../personal-data/forget-ledger.ts";
import { pruneAsApplied, reconciliationRulesOf } from "../personal-data/ledger-prune.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_GRACE_MS,
  FORGET_LEDGER_LAST_RUN,
  FORGET_LEDGER_REREAD_MS,
} from "../personal-data/reconciliation.ts";
import { appRetentionDue } from "../personal-data/retention.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import {
  GENERATION_INTERVAL_MS,
  RESTORE_COUNT_MARK,
  RESTORE_COVERED,
  RESTORE_GENERATION,
  RESTORE_MARK,
  RESTORE_RECOUNTED_MARK,
  RESTORES_FOUND,
} from "./restores.ts";

// The model of restore counting, and a property that walks interleavings of what can happen to a
// database, its forget ledger, backups and two instances, comparing what the runtime counts with
// what the model says it must.
//
// What is true: a restore puts back a copy; it goes back when the copy lacks an event the database
// held, a restore it handled, or holds a lower generation. Restores the app touched nothing in
// between are one going back, which is all it can ever tell. What is observable: the database, the
// ledger (marks, counts, committed entries, intentions with where the database stood) and what each
// running instance read or committed. A going back is proved, at a look that reads it, by:
//   - the ledger's mark above the database's generation, or its count above the database's, which a
//     pass and a start read; on KV, of those raised since the latest restore counted, which a copy
//     brings back as it held it, also a mark raised before a lower one, and no recount;
//   - an entry written after the latest restore counted, committed and whose event the database
//     lacks, or written where the database had gone further than it now stands, which a start
//     reads, and a pass whose reconciliation reads the ledger through; one written by then is what
//     that restore lost, however late the ledger shows or takes it;
//   - what an instance running when the copy came back read or committed past it, which its own
//     next pass reads, or its stop leaves in the ledger as a mark: a generation past the copy's, a
//     count past it, the same count counted later, or its newest event gone while the count stayed
//     as it read it.
// Each look must count, once, a going back it proves; one nothing proves reads the same as a
// database that never went back, and counts nothing. An operator's declaration counts unless the
// database stands where handling the last restore left it and nothing proves another; the operator
// then says `again` for a copy. On KV, one that would count nothing before the reads show every
// mark raised before the start waits until they do, the model's time going on. The runtime's count
// is how many restores an instance handled first, and, while the ledger took every count, the
// count the database holds.
//
// An operator prunes the ledger with no app (`bounda forget-ledger prune`), at any moment, with a
// `keepFor` of nothing, so only what the database has applied bounds it: what the ledger proves of
// the database must read the same after a prune as before, and a prune removes only entries the
// database holds the event of or will not read again, and intentions nothing can apply: the
// database stands where they were written or further, and the person holds no key in force they
// name, or, for a redaction's, no event the redaction reaches holds a value their keys open, or,
// for a retention's, the retention would not forget them now, as the retention says. The ledger
// moves to another store now and then, its entries with it: the store it left keeps them, which
// no app reads, and the prune removes there only what the database holds or nothing applies,
// whatever its cursor read, so what that store would prove of the database, read again, stays.

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), email: notPersonal(z.email()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ email: command.payload.email })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const START = new Date("2026-04-01T00:00:00.000Z");
const RECONCILE_EVERY_MS = 24 * 60 * 60_000;
const RETENTION_MS = 24 * 60 * 60_000;

type Instance = 0 | 1;
const INSTANCES: readonly Instance[] = [0, 1];

// `commitsDown` takes intentions and refuses committed copies, as a ledger that went down between.
type LedgerMode = "up" | "down" | "dropping" | "commitsDown";
type Round = "pass" | "crash" | "stop";

type InstanceAction =
  | { readonly kind: "start"; readonly instance: Instance }
  | { readonly kind: "stop"; readonly instance: Instance }
  | { readonly kind: "crash"; readonly instance: Instance }
  | { readonly kind: "write"; readonly instance: Instance }
  | { readonly kind: "forget"; readonly instance: Instance; readonly person: number }
  | { readonly kind: "forgetUncommitted"; readonly instance: Instance; readonly person: number }
  // A forgetting whose commit failed, asked again: the first intention stays, which nothing applies.
  | { readonly kind: "forgetRetried"; readonly instance: Instance; readonly person: number }
  // A redaction of the person's registration whose commit failed, and one asked again after it.
  | { readonly kind: "redactUncommitted"; readonly instance: Instance; readonly person: number }
  | { readonly kind: "redactRetried"; readonly instance: Instance; readonly person: number }
  // The person active again, which the retention reads.
  | { readonly kind: "touch"; readonly instance: Instance; readonly person: number }
  // A pass whose every commit fails, as one whose retention forgets in a database that refuses.
  | { readonly kind: "retainUncommitted"; readonly instance: Instance }
  | { readonly kind: "pass"; readonly instance: Instance };

// What happens beside the instances, as the operator's prune does.
type Beside = InstanceAction | { readonly kind: "prune" };

type Action =
  | InstanceAction
  | { readonly kind: "prune" }
  | { readonly kind: "tick" }
  // As long as the retention keeps a person idle.
  | { readonly kind: "age" }
  // The ledger moves to another store, its entries with it, and the store it left keeps them.
  | { readonly kind: "move" }
  | { readonly kind: "backUp"; readonly slot: number }
  | {
      readonly kind: "restore";
      readonly slot: number;
      readonly round: readonly [Round, Round];
    }
  | { readonly kind: "ledger"; readonly mode: LedgerMode }
  | { readonly kind: "release" }
  | { readonly kind: "declare"; readonly instance: Instance }
  | { readonly kind: "together"; readonly first: Beside; readonly second: Beside };

// ---------------------------------------------------------------------------------------------
// The world: one database, one ledger, two instances.

type Rows = ReadonlyMap<string, readonly Record<string, SQLInputValue>[]>;

// `all` compares the highest value with the database, `whole` and `shown` on KV every value raised
// since the latest restore counted, and what the reads show of them.
type MarkView = "all" | "whole" | "shown" | "none";

// A value raised before a lower one, at a later time.
const droppedIn = (points: readonly ForgetLedgerMark[]): boolean => {
  const byTime = [...points].sort((a, b) => Date.parse(a.raisedAt) - Date.parse(b.raisedAt));
  return byTime.some((later) =>
    byTime.some(
      (earlier) =>
        Date.parse(earlier.raisedAt) < Date.parse(later.raisedAt) && earlier.value > later.value,
    ),
  );
};

interface EventRow {
  readonly id: string;
  readonly position: number;
}

interface Snapshot {
  readonly events: readonly EventRow[];
  readonly generation: number;
  readonly restores: number;
  // When the database says the latest restore was counted.
  readonly covered: number;
  // Who the database holds a key for, unforgotten.
  readonly holding: ReadonlySet<string>;
}

// What the runtime counted in the database's line of copies, as the model keeps it, apart from the
// rows the runtime writes: the restores it handled first, each by when it was counted, when it last
// counted one, and where handling the last one left the database. A copy brings back its own.
interface Lineage {
  readonly counts: readonly number[];
  readonly covered: number;
  readonly handled: Handled | undefined;
}

// Where the database stood once the last restore counted was handled: its newest event, and the
// restores handled, which a copy taken before holds fewer of.
interface Handled {
  readonly head: EventRow | null;
  readonly counts: readonly number[];
}

interface Copy {
  readonly rows: Rows;
  readonly snapshot: Snapshot;
  readonly lineage: Lineage;
}

const tablesOf = (db: DatabaseSync): readonly string[] =>
  (
    db
      .prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" LIKE 'bounda_%'`)
      .all() as { name: string }[]
  ).map(({ name }) => name);

// What a backup tool copies: every table, and the counter behind the events' positions.
const rowsOf = (db: DatabaseSync): Rows =>
  new Map([
    ...tablesOf(db).map(
      (name) =>
        [
          name,
          db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, SQLInputValue>[],
        ] as const,
    ),
    [
      "sqlite_sequence",
      db.prepare(`SELECT * FROM sqlite_sequence`).all() as Record<string, SQLInputValue>[],
    ],
  ]);

const putBack = (db: DatabaseSync, rows: Rows): void => {
  db.exec("BEGIN IMMEDIATE");
  for (const table of rows.keys()) db.exec(`DELETE FROM "${table}"`);
  for (const [table, kept] of rows) {
    for (const row of kept) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column] ?? null));
    }
  }
  db.exec("COMMIT");
};

const rowOf = (db: DatabaseSync, name: string): number =>
  (
    db.prepare(`SELECT "position" FROM "bounda_checkpoints" WHERE "subscriber" = ?`).get(name) as
      | { position: number }
      | undefined
  )?.position ?? 0;

const snapshotOf = (db: DatabaseSync): Snapshot => ({
  events: db
    .prepare(`SELECT "id", "position" FROM "bounda_events" ORDER BY "position"`)
    .all() as unknown as EventRow[],
  generation: rowOf(db, RESTORE_GENERATION),
  restores: rowOf(db, RESTORES_FOUND),
  covered: rowOf(db, RESTORE_COVERED),
  holding: new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT "person" FROM "bounda_personal_keys" WHERE "retained_since" IS NULL`,
        )
        .all() as { person: string }[]
    ).map(({ person }) => person),
  ),
});

// How long a read of the KV ledger may lag a write: a few ticks, so lags end within a trace.
const KV_DELAY_MS = 2 * GENERATION_INTERVAL_MS;

type KvValue =
  | { readonly kind: "entry"; readonly entry: ForgetLedgerEntry }
  | { readonly kind: "mark"; readonly name: string; readonly mark: ForgetLedgerMark };

// A put, or a delete when `value` is `null`, as Workers KV takes it: a read shows it from some
// moment within `KV_DELAY_MS` of when it landed, `showsAt`, and until then the key as the writes
// before it left it. Of the writes a read shows, the last one landed wins.
interface KvWrite {
  readonly key: string;
  readonly value: KvValue | null;
  readonly order: number;
  readonly showsAt: number;
}

// Workers KV as one location's reads see it: every key a write lands under shows within the delay,
// each after a lag of its own, a delete as a put; once shown, it stays shown until a later write
// to the key shows. `lagOf` picks each write's lag, at most `KV_DELAY_MS`.
const createLaggingKv = (now: () => number, lagOf: () => number) => {
  const writes: KvWrite[] = [];
  const write = (key: string, value: KvValue | null): void => {
    writes.push({ key, value, order: writes.length, showsAt: now() + lagOf() });
  };
  // Each key as a read now shows it, or as it is once every write shows.
  const view = (shownOnly: boolean): ReadonlyMap<string, KvValue> => {
    const latest = new Map<string, KvWrite>();
    for (const landed of writes) {
      if (shownOnly && landed.showsAt > now()) continue;
      const kept = latest.get(landed.key);
      if (kept === undefined || kept.order < landed.order) latest.set(landed.key, landed);
    }
    return new Map(
      [...latest].flatMap(([key, { value }]) => (value === null ? [] : [[key, value] as const])),
    );
  };
  return {
    put: (key: string, value: KvValue): void => write(key, value),
    delete: (key: string): void => write(key, null),
    view,
    clear: (): void => {
      for (const key of view(false).keys()) write(key, null);
    },
  };
};

const byMarkValue = (a: ForgetLedgerMark, b: ForgetLedgerMark): number =>
  b.value - a.value || Date.parse(a.raisedAt) - Date.parse(b.raisedAt);

// The marks `name` holds in a KV view, highest first.
const marksIn = (view: ReadonlyMap<string, KvValue>, name: string): ForgetLedgerMark[] =>
  [...view.values()]
    .flatMap((held) => (held.kind === "mark" && held.name === name ? [held.mark] : []))
    .sort(byMarkValue);

// The entries a KV view holds, a committed copy winning over the intention of the same event, as
// `kvForgetLedger` reads them.
const entriesIn = (view: ReadonlyMap<string, KvValue>): ForgetLedgerEntry[] => {
  const byEvent = new Map<string, ForgetLedgerEntry>();
  for (const held of view.values()) {
    if (held.kind !== "entry") continue;
    const kept = byEvent.get(held.entry.eventId);
    if (kept === undefined || kept.committed === false) byEvent.set(held.entry.eventId, held.entry);
  }
  return [...byEvent.values()].sort(byForgetLedgerOrder);
};

// A ledger as a remote store is: down, down for committed copies alone, or taking writes it lands
// only later, as a call given up for its timeout does. A mark only ever goes up, whoever raises it.
// The SQL ledger reads every write at once. Workers KV keeps every value raised under a mark, and
// a write, an entry's, its intention's removal, a mark's or a prune's, shows only after a lag of
// its own, at most `KV_DELAY_MS`.
const createModelLedger = (
  kind: "sql" | "kv",
  gate: () => Promise<void>,
  now: () => number,
  lagOf: () => number,
) => {
  const inner = createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);
  const kv = createLaggingKv(now, lagOf);
  const marks = new Map<string, ForgetLedgerMark[]>();
  // Every value raised under `name`, or what a read shows now, on either ledger.
  const raisedUnder = (name: string, shownOnly = false): readonly ForgetLedgerMark[] =>
    kind === "sql" ? (marks.get(name) ?? []) : marksIn(kv.view(shownOnly), name);
  const highestOf = (name: string): number =>
    raisedUnder(name).reduce((highest, { value }) => Math.max(highest, value), 0);
  const markKey = (name: string, { value, raisedAt }: ForgetLedgerMark): string =>
    `mark/${name}/${value}/${raisedAt}`;
  let mode: LedgerMode = "up";
  // When each committed entry landed, and when the ledger last came back up.
  const committedAt = new Map<string, number>();
  let upSince = Number.NEGATIVE_INFINITY;
  let dropped: (() => Promise<void>)[] = [];
  const refuse = (): never => {
    throw new Error("the ledger is down");
  };
  const write = async (work: () => Promise<void>): Promise<void> => {
    await gate();
    if (mode === "down") refuse();
    if (mode === "dropping") {
      dropped.push(work);
      refuse();
    }
    await work();
  };
  const reading = async (): Promise<void> => {
    await gate();
    if (mode === "down" || mode === "dropping") refuse();
  };
  // What a read shows now of the entries, or every one.
  const entriesOf = (shownOnly: boolean): readonly ForgetLedgerEntry[] =>
    kind === "sql" ? [] : entriesIn(kv.view(shownOnly));
  const ledger: ForgetLedger = {
    // Workers KV lists a key within the delay: the app reads the ledger once more after it.
    ...(kind === "kv" ? { visibilityDelayMs: KV_DELAY_MS } : {}),
    append: (entries) =>
      mode === "commitsDown" && entries.some(({ committed }) => committed !== false)
        ? gate().then(refuse)
        : write(async () => {
            for (const { eventId, committed } of entries) {
              if (committed !== false && !committedAt.has(eventId)) committedAt.set(eventId, now());
            }
            if (kind === "sql") return inner.append(entries);
            // An intention and its committed copy each have a key, as `kvForgetLedger` writes them.
            for (const entry of entries) {
              if (entry.committed === false) {
                kv.put(`intended/${entry.eventId}`, { kind: "entry", entry: { ...entry } });
                continue;
              }
              const { committed: _, ...committed } = entry;
              kv.put(`committed/${entry.eventId}`, { kind: "entry", entry: committed });
              kv.delete(`intended/${entry.eventId}`);
            }
          }),
    read: async (args: ReadForgetLedgerArgs) => {
      await reading();
      if (kind === "sql") return inner.read(args);
      const { after, limit } = args;
      return entriesOf(true)
        .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
        .slice(0, limit);
    },
    readMark: async (name) => {
      await reading();
      if (kind === "kv") return raisedUnder(name, true);
      const [highest] = [...raisedUnder(name)].sort(byMarkValue);
      return highest === undefined ? [] : [{ value: highest.value, raisedAt: highest.raisedAt }];
    },
    raiseMark: (name, mark) =>
      write(async () => {
        if (kind === "kv") {
          if (!kv.view(false).has(markKey(name, mark))) {
            kv.put(markKey(name, mark), { kind: "mark", name, mark: { ...mark } });
          }
          return;
        }
        // A ledger that reads what was written keeps the highest value, raised first.
        if (mark.value <= highestOf(name)) return;
        marks.set(name, [{ value: mark.value, raisedAt: mark.raisedAt }]);
      }),
    ...(kind === "kv"
      ? {
          // As `kvForgetLedger` prunes: of what a read shows, the highest raised before stays.
          pruneMarks: async (name: string, before: string) => {
            await reading();
            const pruned = raisedUnder(name, true)
              .filter(({ raisedAt }) => raisedAt < before)
              .slice(1);
            for (const mark of pruned) kv.delete(markKey(name, mark));
          },
        }
      : {}),
    clear: async () => {
      kv.clear();
      return inner.clear();
    },
    fence: inner.fence,
    // Workers KV expires its keys on its own: only the SQL ledger is pruned.
    ...(kind === "sql"
      ? {
          // What a prune removes landed no longer: a write that lands it again lands it then.
          prune: (args: PruneForgetLedgerArgs) =>
            write(async () => {
              await inner.prune?.(args);
              const kept = new Set(
                (await inner.read({ limit: Number.MAX_SAFE_INTEGER })).map(
                  ({ eventId }) => eventId,
                ),
              );
              for (const eventId of [...committedAt.keys()]) {
                if (!kept.has(eventId)) committedAt.delete(eventId);
              }
            }),
        }
      : {}),
  };
  return {
    ledger,
    mark: (): number => highestOf(RESTORE_MARK),
    // When the highest value of the mark was first raised.
    markRaisedAt: (): number => {
      const [highest] = [...raisedUnder(RESTORE_MARK)].sort(byMarkValue);
      return highest === undefined ? 0 : Date.parse(highest.raisedAt);
    },
    // What a read shows now of the mark, raised from `after` on, or all that was.
    pointsFrom: (after: number, shownOnly: boolean): readonly ForgetLedgerMark[] =>
      raisedUnder(RESTORE_MARK, shownOnly).filter((raised) => Date.parse(raised.raisedAt) >= after),
    // The highest count of restores raised from `after` on, of what a read shows now or of all,
    // a recount's aside; a ledger that reads what was written keeps the highest alone.
    countFrom: (after: number, shownOnly: boolean): number => {
      const recounted = raisedUnder(RESTORE_RECOUNTED_MARK, shownOnly);
      return raisedUnder(RESTORE_COUNT_MARK, shownOnly)
        .filter(
          ({ value, raisedAt }) =>
            Date.parse(raisedAt) >= after &&
            !recounted.some((recount) => recount.value === value && recount.raisedAt === raisedAt),
        )
        .reduce((highest, { value }) => Math.max(highest, value), 0);
    },
    marks: (): readonly (readonly [string, readonly ForgetLedgerMark[]])[] =>
      [RESTORE_MARK, RESTORE_COUNT_MARK, RESTORE_RECOUNTED_MARK].flatMap((name) => {
        const raised = raisedUnder(name);
        return raised.length === 0 ? [] : [[name, raised] as const];
      }),
    // Every entry the ledger holds, or, on KV, what a read shows of them now.
    entries: async (shownOnly = false): Promise<readonly ForgetLedgerEntry[]> =>
      kind === "sql" ? inner.read({ limit: Number.MAX_SAFE_INTEGER }) : entriesOf(shownOnly),
    mode: (): LedgerMode => mode,
    upSince: (): number => upSince,
    // The committed entries that landed by `at`.
    committedBy: async (at: number): Promise<readonly ForgetLedgerEntry[]> =>
      (kind === "sql"
        ? await inner.read({ limit: Number.MAX_SAFE_INTEGER })
        : entriesOf(false)
      ).filter(
        (entry) => entry.committed !== false && (committedAt.get(entry.eventId) ?? at + 1) <= at,
      ),
    set: (next: LedgerMode): void => {
      if (next === "up" && mode !== "up") upSince = now();
      mode = next;
    },
    release: async (): Promise<void> => {
      const landing = dropped;
      dropped = [];
      for (const land of landing) await land();
    },
  };
};

interface Memory {
  readonly generation: number;
  readonly restores: number;
  readonly covered: number;
  readonly witness: EventRow | null;
}

interface Live {
  readonly app: BoundaApp<Registry>;
  readonly clock: FixedClock;
  readonly prefix: string;
  readonly startedAt: number;
  // On KV, whether the marks raised and the entries written before it started proved more than its
  // reads showed then: what it counts once they show every one.
  owed: boolean;
  // The events it committed, whose copies it appends to the ledger again before each look.
  readonly commits: Set<string>;
  // When it last read the ledger through for a start or a restore it found: what had landed by
  // then is applied once its reads show it.
  anchor: number;
  memory: Memory;
}

const RESTARTED = "the database went back to an earlier copy; background jobs start over";

interface ModelRun {
  // How many restores the model says the instances must have handled first, and how many they did.
  readonly expected: number;
  readonly counted: number;
  // The count the database holds at the end.
  readonly stored: number;
  readonly answered: boolean;
  readonly violations: readonly string[];
  readonly trace: readonly string[];
}

// The lag of each write to the KV ledger in turn, again from the first once all are taken; every
// write lags the whole delay without any.
const lagsOf = (lags: readonly number[]): (() => number) => {
  let next = 0;
  return () => {
    const lag = lags[next % Math.max(1, lags.length)] ?? KV_DELAY_MS;
    next += 1;
    return Math.min(lag, KV_DELAY_MS);
  };
};

const createWorld = (
  kind: "sql" | "kv",
  scheduler?: fc.Scheduler,
  lags: readonly number[] = [],
) => {
  // While two instances act at once, the scheduler decides in which order each call to the ledger
  // answers.
  let interleaving = false;
  const gate = async (): Promise<void> => {
    if (interleaving && scheduler !== undefined) await scheduler.schedule(Promise.resolve());
  };
  const { adapter, db } = createNodeSqliteAdapter(":memory:");
  const keys = createEphemeralKeys();
  const ledger = createModelLedger(kind, gate, () => now, lagsOf(lags));
  const definition = defineForgetLedger(() => ledger.ledger);
  // The store the ledger last moved from, which no app reads.
  const former = createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);
  const config: Config = {
    storage: adapter,
    runtime: {
      personalData: {
        keyWrapper: keys.keyWrapper,
        tenantKeys: keys.tenantKeys,
        retention: "1d",
        forgetLedger: { store: definition, reconcileEvery: RECONCILE_EVERY_MS },
      },
      policies: { retry: { strategy: "none" } },
    },
  };
  const rules = reconciliationRulesOf({ registry, config: resolveConfig(config) });
  const instances: (Live | null)[] = [null, null];
  const backups = new Map<number, Copy>();
  let now = START.getTime();
  let started = 0;
  let persons = 0;
  let firsts = 0;
  const trace: string[] = [];
  // What the runtime answered that the model says it must not.
  const violations: string[] = [];

  // Going backs no look proved yet, each the database it replaced and the copy.
  interface Episode {
    readonly replaced: Snapshot;
    readonly copy: Snapshot;
    // The instances running when it happened that read or committed what the copy lacks.
    readonly remembered: Set<Live>;
  }
  let open: Episode[] = [];
  // The restores since the app last touched the database: the database the first replaced, and
  // the going back they make, if any.
  let unlooked: {
    replaced: Snapshot;
    counts: readonly number[];
    episode: Episode | null;
  } | null = null;
  let expected = 0;
  // How many times the database truly went back, as the model sees it.
  let goingBacks = 0;
  let lineage: Lineage = { counts: [], covered: 0, handled: undefined };

  const logger = (instance: Instance): Logger => {
    const at =
      (level: string) =>
      (message: string, fields?: LogFields): void => {
        if (message === RESTARTED && fields?.first === true) {
          firsts += 1;
          lineage = { ...lineage, counts: [...lineage.counts, firsts], covered: now };
        }
        const live = instances[instance];
        if (message === RESTARTED && live != null) live.anchor = now;
        if (process.env.BOUNDA_MODEL_LOG === "1") {
          trace.push(
            `  ! ${level} ${message} ${JSON.stringify(fields, (key, value) => (key === "error" ? String(value) : value))}`,
          );
        }
      };
    return { ...silentLogger, warn: at("warn"), error: at("error") };
  };

  // What an instance read at a look.
  const memoryOf = (): Memory => {
    const snapshot = snapshotOf(db);
    return {
      generation: snapshot.generation,
      restores: snapshot.restores,
      covered: snapshot.covered,
      witness: snapshot.events.at(-1) ?? null,
    };
  };

  // The newest event an instance committed is what it watches from then on, unless it watches a
  // newer one; one that committed nothing watches what it read.
  const committedBy = (live: Live): void => {
    const owns = snapshotOf(db).events.filter(({ id }) => id.startsWith(live.prefix));
    for (const { id } of owns) live.commits.add(id);
    const own = owns.at(-1);
    const { witness } = live.memory;
    if (own !== undefined && (witness === null || own.position > witness.position)) {
      live.memory = { ...live.memory, witness: own };
    }
  };

  // What a running instance read or committed that the copy lacks.
  // A count past what it read was moved by another instance, which counted a restore of a copy
  // without its newest event as well as one taken after: the event lost tells it nothing more.
  // The same count, counted later than the copy says, is a count the copy lacks.
  const remembers = (memory: Memory, copy: Snapshot): boolean => {
    if (memory.generation > copy.generation || memory.restores > copy.restores) return true;
    if (memory.restores === copy.restores && memory.covered > copy.covered) return true;
    const { witness } = memory;
    if (witness === null || memory.restores < copy.restores) return false;
    return copy.events.find(({ position }) => position === witness.position)?.id !== witness.id;
  };

  // A copy lacks a restore the database it replaced handled, whatever value its count took: on KV a
  // count the reads did not show takes a value already counted.
  const wentBack = (
    replaced: Snapshot,
    replacedCounts: readonly number[],
    copy: Snapshot,
    copyCounts: readonly number[],
  ): boolean =>
    copy.generation < replaced.generation ||
    replacedCounts.some((count) => !copyCounts.includes(count)) ||
    replaced.events.some(
      ({ id, position }) => copy.events.find((event) => event.position === position)?.id !== id,
    );

  // What the ledger proves of the database as it now stands, for a look that reads it.
  // What the mark proves of the database: past its generation, on a ledger that reads what was
  // written. On KV, of what was raised since the latest restore counted, a value past it or one
  // raised before a lower one, the database having held it and then less; what every read shows
  // of it, and nothing before the instance's reads show every mark raised before it started.
  // A count of restores past the one the database holds, raised since the latest restore counted,
  // proves it too: a copy from before that count.
  const markProves = (view: MarkView, { generation, restores }: Snapshot): boolean => {
    if (view === "all") return ledger.mark() > generation || ledger.countFrom(0, false) > restores;
    if (kind === "sql") {
      // A value raised before the latest restore counted is what it left behind, though a count
      // that could not read it did not move past it.
      const behind = ledger.mark() > generation && ledger.markRaisedAt() >= lineage.covered;
      return behind || ledger.countFrom(lineage.covered, false) > restores;
    }
    if (view === "none") return false;
    const shownOnly = view === "shown";
    const points = ledger.pointsFrom(lineage.covered, shownOnly);
    return (
      points.some(({ value }) => value > generation) ||
      droppedIn(points) ||
      ledger.countFrom(lineage.covered, shownOnly) > restores
    );
  };

  // Of the entries, on KV, what a read shows now, or every one.
  const readable = (): boolean => ledger.mode() === "up" || ledger.mode() === "commitsDown";

  const ledgerProves = async (
    entries: "whole" | "shown" | "none",
    view: MarkView = "shown",
  ): Promise<boolean> => {
    if (!readable()) return false;
    const current = snapshotOf(db);
    if (markProves(view, current)) return true;
    return (
      entries !== "none" &&
      (await entriesProve(readFromCursor(await ledger.entries(entries === "shown"))))
    );
  };

  // What a reconciliation reads of the ledger: from a while before the time of the last entry the
  // database applied, its cursor, which a copy brings back as it held it.
  const readFromCursor = (
    entries: readonly ForgetLedgerEntry[],
    cursor = rowOf(db, FORGET_LEDGER_CURSOR),
  ): readonly ForgetLedgerEntry[] =>
    cursor === 0
      ? entries
      : entries.filter(
          ({ forgottenAt }) => Date.parse(forgottenAt) >= cursor - FORGET_LEDGER_REREAD_MS,
        );

  // What a look that reads these entries proves of the database as it now stands: of those
  // written after the latest restore counted, a committed one whose event the database lacks, or
  // one written where the database had gone further than it now stands. One written by then is what
  // that restore lost, or one before, as a read that shows it only after the count tells: the
  // database holding it since, and losing it again, leaves nothing a look reads but what tells that
  // going back otherwise.
  // Events are only ever appended: a database holding fewer than when an entry was written went
  // back since, however far its generation moved.
  const entriesProve = async (
    entries: readonly ForgetLedgerEntry[],
    current: Snapshot = snapshotOf(db),
    covered = lineage.covered,
  ): Promise<boolean> => {
    const held = new Set(current.events.map(({ id }) => id));
    const last = current.events.at(-1)?.position ?? 0;
    return entries.some(({ forgottenAt, committed, eventId, reached }) => {
      if (Date.parse(forgottenAt) <= covered) return false;
      if (committed !== false && !held.has(eventId)) return true;
      return (
        reached !== undefined &&
        (reached.generation > current.generation || reached.position > last)
      );
    });
  };

  const headNow = (): Handled => {
    const snapshot = snapshotOf(db);
    return { head: snapshot.events.at(-1) ?? null, counts: lineage.counts };
  };
  // Where a pass that counted a restore left the database once it handled it: its retention runs
  // after, and what it forgets anew, of which neither the database nor the ledger held anything
  // when the pass began, is new.
  const handledBy = (held: ReadonlySet<string>, recorded: ReadonlySet<string>): Handled => {
    const rows = db
      .prepare(`SELECT "id", "position", "type" FROM "bounda_events" ORDER BY "position"`)
      .all() as unknown as (EventRow & { readonly type: string })[];
    const handling = rows.filter(
      ({ id, type }) => held.has(id) || recorded.has(id) || type !== "PersonalDataForgotten",
    );
    const last = handling.at(-1);
    return {
      head: last === undefined ? null : { id: last.id, position: last.position },
      counts: lineage.counts,
    };
  };
  const standsWhereHandled = (): boolean => {
    const { head, counts } = headNow();
    const { handled } = lineage;
    return (
      handled !== undefined &&
      head?.id === handled.head?.id &&
      head?.position === handled.head?.position &&
      counts.length === handled.counts.length &&
      counts.every((count, index) => handled.counts[index] === count)
    );
  };

  const proved = (why: string): void => {
    if (open.length === 0) return;
    expected += 1;
    trace.push(`    proved by ${why}`);
    open = [];
    settledAfter = true;
    for (const live of instances) if (live !== null) live.owed = false;
  };
  // Whether the look under way counted, so where it leaves the database is where handling it left it.
  let settledAfter = false;

  // What a look by `instance` can prove, read before it looks: a start reads the ledger's entries
  // too, a pass what the instance remembers.
  const proofFor = async (
    instance: Instance,
    kindOfLook: "start" | "pass",
  ): Promise<string | null> => {
    if (open.length === 0) return null;
    const live = instances[instance];
    if (
      kindOfLook === "pass" &&
      open.some(({ remembered }) => live != null && remembered.has(live))
    ) {
      return `what instance ${instance} remembers`;
    }
    if (kindOfLook === "pass" && live?.owed === true && viewOf(live) === "shown" && readable()) {
      return "what was written before its start, once its reads show it";
    }
    const view = kindOfLook === "start" ? "shown" : viewOf(live ?? null);
    return (await ledgerProves(kindOfLook === "start" ? "shown" : "none", view))
      ? "the ledger"
      : null;
  };

  // What a running instance compares of the mark: on KV, nothing before its reads show every mark
  // raised before it started.
  const viewOf = (live: Live | null): MarkView =>
    live !== null && now >= live.startedAt + KV_DELAY_MS ? "shown" : "none";

  // A look counts what it proves then, not at a later one: on KV the start's reconciliation a
  // delay later applies, and counts, what its reads could not show at first. Looks at once, two
  // together or a restore's round, are compared once all are done.
  let together = false;
  const countedAsProved = (): void => {
    if (firsts !== expected) {
      violations.push(`after the look, ${firsts} counted, the model says ${expected}`);
    }
  };
  const looked = (proof: string | null): void => {
    unlooked = null;
    if (proof !== null) proved(proof);
    if (!interleaving && !together) countedAsProved();
  };

  const startInstance = async (instance: Instance): Promise<void> => {
    if (instances[instance] !== null || starting.has(instance)) return;
    // A Durable Object, the one app a KV ledger serves, runs once at a time, a start under way too.
    if (kind === "kv" && (instances.some((live) => live !== null) || starting.size > 0)) return;
    starting.add(instance);
    try {
      await startingInstance(instance);
    } finally {
      starting.delete(instance);
    }
  };
  // The instances whose start is under way.
  const starting = new Set<Instance>();

  const startingInstance = async (instance: Instance): Promise<void> => {
    started += 1;
    const prefix = `i${instance}s${started}-`;
    const startedAt = now;
    const proof = await proofFor(instance, "start");
    // What the whole of the marks raised since the latest restore counted and of the entries
    // proves, the reads may not show yet: the start compares them once they do, the entries with the
    // reconciliation it makes again then.
    const owed =
      kind === "kv" && proof === null && open.length > 0 && (await ledgerProves("whole", "whole"));
    const clock = createFixedClock(new Date(now));
    const app = await createApp<Registry>({
      registry,
      config,
      env: {},
      ids: createSequentialIdGenerator({ prefix }),
      clock,
      logger: logger(instance),
    });
    const live: Live = {
      app,
      clock,
      prefix,
      startedAt,
      owed,
      commits: new Set(),
      anchor: startedAt,
      memory: memoryOf(),
    };
    instances[instance] = live;
    looked(proof);
    if (settledAfter) lineage = { ...lineage, handled: headNow() };
    settledAfter = false;
    live.memory = memoryOf();
  };

  const pass = async (instance: Instance): Promise<void> => {
    const live = instances[instance];
    if (live === null || live === undefined) return;
    const passProof = await proofFor(instance, "pass");
    // A pass whose reconciliation reads the ledger through, after a restore it found, on a round,
    // or at last after the start's failed, is a look that reads the entries, as a start's is:
    // those written before the pass, the commits it appends again first among them, against the
    // database as the pass found it.
    const readableBefore = readable();
    const before = snapshotOf(db);
    const coveredBefore = lineage.covered;
    const cursorBefore = rowOf(db, FORGET_LEDGER_CURSOR);
    const committedBefore = new Set(
      (await ledger.entries(true))
        .filter(({ committed }) => committed !== false)
        .map(({ eventId }) => eventId),
    );
    const held = new Set(before.events.map(({ id }) => id));
    const recorded = new Set((await ledger.entries()).map(({ eventId }) => eventId));
    await live.app.runUntilIdle();
    const readThrough =
      passProof === null &&
      readableBefore &&
      (await live.app.getLag()).forgetLedger?.reconciled === true &&
      rowOf(db, FORGET_LEDGER_LAST_RUN) >= now &&
      (await entriesProve(
        readFromCursor(
          (
            await ledger.entries(true)
          )
            .filter(({ forgottenAt }) => Date.parse(forgottenAt) < now)
            // Committed by this pass's reconciliation, it read the intention.
            .map((entry) =>
              entry.committed === false ||
              committedBefore.has(entry.eventId) ||
              live.commits.has(entry.eventId)
                ? entry
                : { ...entry, committed: false as const },
            ),
          cursorBefore,
        ),
        before,
        coveredBefore,
      ));
    looked(passProof ?? (readThrough ? "the entries its reconciliation read" : null));
    // A restore the pass found it handles before its retention runs; one the entries its round
    // of reconciliation read tell, after.
    if (settledAfter) {
      lineage = {
        ...lineage,
        handled: passProof === null ? headNow() : handledBy(held, recorded),
      };
    }
    settledAfter = false;
    live.memory = memoryOf();
    await appliedInTime(live);
  };

  // Every committed forgetting that landed by the instance's start, or by a restore it found, is
  // applied once its reads show it, a delay later on KV: the database holds its event, or the
  // person no key it names. Only while the ledger answered and the database took every commit
  // throughout, and the database went back to no copy since, which an instance may not tell.
  let restoredAt = Number.NEGATIVE_INFINITY;
  const appliedInTime = async (live: Live): Promise<void> => {
    const anchor = live.anchor;
    if (interleaving || refusing || refusedAt >= anchor) return;
    if (ledger.mode() !== "up" || ledger.upSince() >= anchor) return;
    if (restoredAt > anchor || now < anchor + (kind === "kv" ? KV_DELAY_MS : 0)) return;
    const held = new Set(snapshotOf(db).events.map(({ id }) => id));
    for (const entry of await ledger.committedBy(anchor)) {
      if (held.has(entry.eventId) || !(await pending(entry))) continue;
      violations.push(`${entry.eventId}, landed by ${anchor}, is not applied at ${now}`);
    }
  };

  // Whether a reconciliation would still apply the entry: a redaction while it would seal a value,
  // a forgetting while the person holds a key it names, and, for one the retention made, while the
  // retention would forget them now. A change of restrictions or a disclosure is left alone.
  const pending = async (entry: ForgetLedgerEntry): Promise<boolean> => {
    if (entry.redaction !== undefined) {
      return entry.redaction.events.some((target) => seals(entry.personId, target));
    }
    if (entry.restriction !== undefined || entry.disclosure !== undefined) return false;
    const keys = (
      db
        .prepare(`SELECT "fingerprint" FROM "bounda_personal_keys" WHERE "person" = ?`)
        .all(entry.personId) as { fingerprint: string }[]
    ).map(({ fingerprint }) => fingerprint);
    if (!keys.some((fingerprint) => entry.fingerprints?.includes(fingerprint) ?? true)) {
      return false;
    }
    return entry.reason !== "retention" || (await dueNow(entry.personId));
  };

  const holdingNow = (): readonly string[] => [...snapshotOf(db).holding].sort();

  // While a commit is refused, nothing can be applied, and a reconciliation that failed for it
  // waits out its hold.
  let refusing = false;
  let refusedAt = Number.NEGATIVE_INFINITY;
  const failNextCommit = (): void => {
    refusing = true;
    refusedAt = now;
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS "model_fail_commit" BEFORE INSERT ON main."bounda_events" BEGIN SELECT RAISE(ABORT, 'the commit failed'); END`,
    );
  };
  // What a command meets while another action makes the database refuse every commit.
  const refusedCommit = (error: unknown): void => {
    if (!(error instanceof Error && error.message.includes("the commit failed"))) throw error;
  };
  const commitAgain = (): void => {
    refusing = false;
    db.exec(`DROP TRIGGER IF EXISTS temp."model_fail_commit"`);
  };

  const formerEntries = (): Promise<readonly ForgetLedgerEntry[]> =>
    former.read({ limit: Number.MAX_SAFE_INTEGER });

  // The operator's prune, with no app, at the model's time: of the ledger, and of the store it
  // left, which the database does not follow.
  const prune = async (): Promise<void> => {
    const storage = await adapter.createStorage();
    try {
      for (const [target, followed] of [
        [ledger.ledger, true],
        [former, false],
      ] as const) {
        const { prune: removes } = target;
        if (removes === undefined) continue;
        await pruneAsApplied({
          ledger: { read: target.read, fence: target.fence, prune: removes },
          forgotten: async () => false,
          withStorage: (work) => work(storage),
          rules: () => rules,
          keepForMs: 0,
          now: new Date(now),
          followed,
        }).catch(() => {
          // The ledger is down, or takes the prune only later.
        });
      }
    } finally {
      await storage.close();
    }
  };

  // Whether the retention would forget the person now, as it decides: the model has no category.
  const dueNow = async (personId: string): Promise<boolean> => {
    const storage = await adapter.createStorage();
    try {
      const due = appRetentionDue({
        categories: rules.categories,
        batchSize: rules.batchSize,
        checkpoints: storage.checkpointStore,
      });
      return await due(storage, personId, new Date(now), null);
    } finally {
      await storage.close();
    }
  };

  // Whether a redaction of the target would make a value of the person unreadable: one its
  // registration holds sealed under a key they hold, in force or kept.
  const seals = (personId: string, target: { readonly id: string; readonly type: string }) => {
    const event = db
      .prepare(`SELECT "payload", "person", "type" FROM "bounda_events" WHERE "id" = ?`)
      .get(target.id) as { payload: string; person: string | null; type: string } | undefined;
    if (event === undefined || event.person !== personId || event.type !== target.type) {
      return false;
    }
    const email: unknown = (JSON.parse(event.payload) as { email?: unknown }).email;
    if (!isSealed(email)) return email !== undefined && email !== null;
    return (
      email.$personal.person === personId &&
      db
        .prepare(`SELECT 1 FROM "bounda_personal_keys" WHERE "person" = ? AND "fingerprint" = ?`)
        .get(personId, email.$personal.key) !== undefined
    );
  };

  // An intention whose commit the database lacks that nothing applies: the database stands where
  // it was written or further, and the person holds no key in force it names, or, for a
  // redaction's, nothing is left for it to seal, or, for a retention's, the retention would not
  // forget them now, as the retention decides.
  const inapplicable = async (entry: ForgetLedgerEntry): Promise<boolean> => {
    if (entry.committed !== false) return false;
    const { reached } = entry;
    const current = snapshotOf(db);
    const last = current.events.at(-1)?.position ?? 0;
    if (
      reached !== undefined &&
      (reached.generation > current.generation || reached.position > last)
    ) {
      return false;
    }
    if (entry.redaction !== undefined) {
      return !entry.redaction.events.some((target) => seals(entry.personId, target));
    }
    const keys = (
      db
        .prepare(
          `SELECT "fingerprint" FROM "bounda_personal_keys" WHERE "person" = ? AND "retained_since" IS NULL`,
        )
        .all(entry.personId) as { fingerprint: string }[]
    ).map(({ fingerprint }) => fingerprint);
    if (!keys.some((fingerprint) => entry.fingerprints?.includes(fingerprint) ?? true)) return true;
    return entry.reason === "retention" && !(await dueNow(entry.personId));
  };

  // A prune nothing runs beside: it changes nothing a look reads, and nothing a look that read the
  // store the ledger left would.
  const pruneAlone = async (): Promise<void> => {
    const entries = await ledger.entries();
    const left = await formerEntries();
    const proves = await ledgerProves("whole", "all");
    const leftProves = await entriesProve(left);
    const cursor = rowOf(db, FORGET_LEDGER_CURSOR);
    const held = new Set(snapshotOf(db).events.map(({ id }) => id));
    await prune();
    const kept = new Set((await ledger.entries()).map(({ eventId }) => eventId));
    for (const entry of entries) {
      if (kept.has(entry.eventId) || held.has(entry.eventId) || (await inapplicable(entry))) {
        continue;
      }
      if (cursor === 0 || Date.parse(entry.forgottenAt) >= cursor - FORGET_LEDGER_REREAD_MS) {
        violations.push(`the prune removed ${entry.eventId}, which the database has yet to apply`);
      }
    }
    const keptThere = new Set((await formerEntries()).map(({ eventId }) => eventId));
    for (const entry of left) {
      if (keptThere.has(entry.eventId) || held.has(entry.eventId) || (await inapplicable(entry))) {
        continue;
      }
      violations.push(
        `the prune removed ${entry.eventId} from the store the ledger left, which the database lacks`,
      );
    }
    if ((await ledgerProves("whole", "all")) !== proves) {
      violations.push(`the prune changed what the ledger proves from ${proves}`);
    }
    if ((await entriesProve(await formerEntries())) !== leftProves) {
      violations.push(`the prune changed what the store the ledger left proves from ${leftProves}`);
    }
  };

  const beside = (action: Beside): Promise<void> =>
    action.kind === "prune" ? prune() : instanceAction(action);

  const instanceAction = async (action: InstanceAction): Promise<void> => {
    const live = instances[action.instance];
    // What an instance writes in between makes a restore after it another going back.
    // A crash writes nothing.
    if ((live != null && action.kind !== "crash") || action.kind === "start") unlooked = null;
    switch (action.kind) {
      case "start":
        return startInstance(action.instance);
      case "pass":
        return pass(action.instance);
      case "stop":
        if (live === null || live === undefined) return;
        instances[action.instance] = null;
        // What it remembers goes to the ledger as a mark, which proves a copy behind it.
        await live.app.stop();
        return;
      case "crash":
        instances[action.instance] = null;
        return;
      case "write": {
        if (live === null || live === undefined) return;
        persons += 1;
        await live.app.commands
          .registerCustomer?.({ customerId: `p${persons}`, email: `p${persons}@example.com` })
          .catch(refusedCommit);
        committedBy(live);
        return;
      }
      case "forget":
      case "forgetUncommitted":
      case "forgetRetried": {
        if (live === null || live === undefined) return;
        const holding = holdingNow();
        const person = holding[action.person % Math.max(1, holding.length)];
        if (person === undefined) return;
        if (action.kind !== "forget") failNextCommit();
        try {
          await live.app.forget(person);
        } catch {
          // The commit failed, or the ledger is down; the intention may be there.
        } finally {
          commitAgain();
        }
        if (action.kind === "forgetRetried") {
          await live.app.forget(person).catch(() => {
            // The ledger is down.
          });
        }
        committedBy(live);
        return;
      }
      case "redactUncommitted":
      case "redactRetried": {
        if (live === null || live === undefined) return;
        const holding = holdingNow();
        const person = holding[action.person % Math.max(1, holding.length)];
        if (person === undefined) return;
        const registration = db
          .prepare(
            `SELECT "id", "aggregate_type", "aggregate_id", "type" FROM "bounda_events" WHERE "person" = ? AND "type" = 'CustomerRegistered' ORDER BY "position" LIMIT 1`,
          )
          .get(person) as
          | { id: string; aggregate_type: string; aggregate_id: string; type: string }
          | undefined;
        if (registration === undefined) return;
        const events = [
          {
            id: registration.id,
            aggregateType: registration.aggregate_type,
            aggregateId: registration.aggregate_id,
            type: registration.type,
            fields: ["email"],
          },
        ];
        failNextCommit();
        try {
          await live.app.redact(person, { events } as never);
        } catch {
          // The commit failed, or the ledger is down; the intention may be there.
        } finally {
          commitAgain();
        }
        if (action.kind === "redactRetried") {
          await live.app.redact(person, { events } as never).catch(() => {
            // The ledger is down.
          });
        }
        committedBy(live);
        return;
      }
      case "touch": {
        if (live === null || live === undefined) return;
        const holding = holdingNow();
        const person = holding[action.person % Math.max(1, holding.length)];
        if (person === undefined) return;
        await live.app.commands
          .registerCustomer?.({ customerId: person, email: `${person}@example.com` })
          .catch(refusedCommit);
        committedBy(live);
        return;
      }
      case "retainUncommitted": {
        failNextCommit();
        try {
          await pass(action.instance);
        } finally {
          commitAgain();
        }
        return;
      }
    }
  };

  const describeAction = (action: Action): string => JSON.stringify(action);

  // What the operator waits for, as long as it takes, the model's time going on meanwhile.
  const waited = async <T>(work: Promise<T>): Promise<T> => {
    let done = false;
    const tracked = work.finally(() => {
      done = true;
    });
    tracked.catch(() => undefined);
    for (let waits = 0; waits < 100; waits += 1) {
      for (let turns = 0; turns < 10 && !done; turns += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (done) break;
      elapse(1_000);
    }
    return tracked;
  };

  const state = (): string => {
    const now = snapshotOf(db);
    return `    gen ${now.generation} restores ${now.restores} last ${now.events.at(-1)?.position ?? 0} mark ${ledger.mark()} counted ${firsts} expected ${expected} open ${open.length}`;
  };

  // Whether the ledger answered every call: then it holds every count, and the database's count
  // is every restore found.
  let answered = true;

  // Every action takes a moment: what each instance raises reads as raised after what came before.
  const elapse = (milliseconds: number): void => {
    now += milliseconds;
    for (const live of instances) live?.clock.advance(milliseconds);
  };

  const run = async (action: Action): Promise<void> => {
    if (action.kind === "ledger" && action.mode !== "up") answered = false;
    elapse(1);
    await step(action);
    trace.push(state());
  };

  const step = async (action: Action): Promise<void> => {
    trace.push(describeAction(action));
    switch (action.kind) {
      case "tick":
        elapse(GENERATION_INTERVAL_MS);
        return;
      case "age":
        elapse(RETENTION_MS);
        return;
      case "move":
        await former.clear();
        await former.append(await ledger.entries());
        return;
      case "backUp":
        // Nothing to copy before the first start creates the tables.
        if (tablesOf(db).length === 0) return;
        backups.set(action.slot, { rows: rowsOf(db), snapshot: snapshotOf(db), lineage });
        return;
      case "restore": {
        const copy = backups.get(action.slot);
        if (copy === undefined) return;
        const replaced = unlooked?.replaced ?? snapshotOf(db);
        const replacedCounts = unlooked?.counts ?? lineage.counts;
        putBack(db, copy.rows);
        lineage = copy.lineage;
        restoredAt = now;
        const goes = wentBack(replaced, replacedCounts, copy.snapshot, copy.lineage.counts);
        // Restores nothing looked at in between are one going back, from what the first replaced.
        // What a stop in between left in the ledger tells this going back as well.
        const before = unlooked?.episode ?? undefined;
        open = open.filter((episode) => episode !== before);
        let episode: Episode | null = null;
        if (goes) {
          episode = {
            replaced,
            copy: copy.snapshot,
            remembered: new Set(
              instances.filter(
                (live): live is Live => live !== null && remembers(live.memory, copy.snapshot),
              ),
            ),
          };
          open.push(episode);
          if (before === undefined) goingBacks += 1;
        } else if (before !== undefined) goingBacks -= 1;
        unlooked = { replaced, counts: replacedCounts, episode };
        // Every instance running looks, stops or is gone before anything else happens.
        together = true;
        try {
          for (const instance of INSTANCES) {
            const round = action.round[instance];
            if (instances[instance] === null) continue;
            if (round === "pass") await pass(instance);
            else await instanceAction({ kind: round, instance });
          }
        } finally {
          together = false;
        }
        countedAsProved();
        return;
      }
      case "ledger":
        ledger.set(action.mode);
        return;
      case "declare": {
        // The operator, as `bounda restored` from a terminal when no instance runs there.
        const transient = instances[action.instance] === null;
        if (transient) await startInstance(action.instance);
        const live = instances[action.instance];
        if (live == null) return;
        unlooked = null;
        // A declaration reads the database and the marks. On KV, one that would count nothing
        // before its reads show every mark raised before its start waits until they do.
        const stands = standsWhereHandled();
        const unjudged = kind === "kv" && (transient || now < live.startedAt + KV_DELAY_MS);
        const provable = await ledgerProves(
          "none",
          unjudged ? (stands ? "whole" : "none") : viewOf(live),
        );
        try {
          const first = await waited(live.app.restored());
          // A declaration made again where handling the last restore left the database, and a
          // copy taken right then, are the same: it counts nothing, and only the operator knows a
          // copy, and says `again`.
          const counts = provable || !stands;
          if (first.counted !== counts) {
            violations.push(`the declaration counted ${first.counted}, the model says ${counts}`);
          }
          let counted = first.counted;
          if (counts) expected += 1;
          if (!first.counted && open.length > 0) {
            counted = (await live.app.restored({ again: true })).counted;
            if (!counted) violations.push("the declaration made again counted nothing");
            if (!counts) expected += 1;
          }
          if (counted) {
            open = [];
            lineage = { ...lineage, handled: headNow() };
            trace.push("    declared");
          }
          // What it read, as one that waited looked.
          if (counted || (unjudged && stands)) live.memory = memoryOf();
        } catch {
          trace.push("    declaration refused");
        }
        if (transient) await instanceAction({ kind: "stop", instance: action.instance });
        return;
      }
      case "release":
        await ledger.release();
        return;
      case "prune":
        return pruneAlone();
      case "together": {
        const { first, second } = action;
        if (
          first.kind !== "prune" &&
          second.kind !== "prune" &&
          first.instance === second.instance
        ) {
          await instanceAction(first);
          await instanceAction(second);
          return;
        }
        // A start reads the database once: beside another instance's commit, what it read is
        // either, so it goes first.
        if (first.kind === "start" || second.kind === "start") {
          together = true;
          try {
            for (const each of second.kind === "start" ? [second, first] : [first, second]) {
              await beside(each);
            }
          } finally {
            together = false;
          }
          countedAsProved();
          return;
        }
        together = true;
        try {
          if (scheduler === undefined) await Promise.all([beside(first), beside(second)]);
          else {
            interleaving = true;
            await scheduler.waitFor(Promise.all([beside(first), beside(second)]));
          }
        } finally {
          interleaving = false;
          together = false;
        }
        countedAsProved();
        return;
      }
      default:
        await instanceAction(action);
    }
  };

  // Everything that can look, looks: each instance running passes and stops, the ledger answers
  // again, and a new instance starts and passes once young entries came of age.
  const settle = async (): Promise<ModelRun> => {
    trace.push("settle");
    ledger.set("up");
    await run({ kind: "release" });
    for (const instance of INSTANCES) await pass(instance);
    trace.push(state());
    for (const instance of INSTANCES) await instanceAction({ kind: "stop", instance });
    trace.push(state());
    now += FORGET_LEDGER_GRACE_MS + 60_000;
    await startInstance(0);
    trace.push(state());
    // Once every read shows what was raised before it started, as many passes as it counts.
    for (const _ of [1, 2, 3]) {
      elapse(KV_DELAY_MS + 1);
      await pass(0);
    }
    await instanceAction({ kind: "stop", instance: 0 });
    trace.push(state());
    return {
      expected,
      counted: firsts,
      stored: rowOf(db, RESTORES_FOUND),
      answered,
      violations,
      trace,
    };
  };

  const close = async (): Promise<void> => {
    for (const instance of INSTANCES) {
      await instances[instance]?.app.stop().catch(() => undefined);
      instances[instance] = null;
    }
  };

  // Everything a look could read: the database's events and rows, and the ledger.
  const observe = async (): Promise<string> =>
    JSON.stringify({
      events: snapshotOf(db).events,
      rows: db
        .prepare(`SELECT "subscriber", "position" FROM "bounda_checkpoints" ORDER BY "subscriber"`)
        .all(),
      // Each world draws keys of its own; the same database holds the same.
      entries: (await ledger.entries()).map(({ fingerprints, ...entry }) => ({
        ...entry,
        keys: fingerprints?.length,
      })),
      marks: ledger.marks(),
    });

  return {
    run,
    settle,
    close,
    observe,
    truth: () => goingBacks,
    entries: ledger.entries,
    formerEntries,
  };
};

// ---------------------------------------------------------------------------------------------
// The property.

const instance = fc.constantFrom<Instance>(0, 1);
const instanceAction: fc.Arbitrary<InstanceAction> = fc.oneof(
  { weight: 3, arbitrary: instance.map((at) => ({ kind: "start" as const, instance: at })) },
  { weight: 1, arbitrary: instance.map((at) => ({ kind: "stop" as const, instance: at })) },
  { weight: 1, arbitrary: instance.map((at) => ({ kind: "crash" as const, instance: at })) },
  { weight: 4, arbitrary: instance.map((at) => ({ kind: "write" as const, instance: at })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ instance, person: fc.nat(8) })
      .map(({ instance: at, person }) => ({ kind: "forget" as const, instance: at, person })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ instance, person: fc.nat(8) }).map(({ instance: at, person }) => ({
      kind: "forgetUncommitted" as const,
      instance: at,
      person,
    })),
  },
  {
    weight: 2,
    arbitrary: fc.record({ instance, person: fc.nat(8) }).map(({ instance: at, person }) => ({
      kind: "forgetRetried" as const,
      instance: at,
      person,
    })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ instance, person: fc.nat(8) }).map(({ instance: at, person }) => ({
      kind: "redactUncommitted" as const,
      instance: at,
      person,
    })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ instance, person: fc.nat(8) }).map(({ instance: at, person }) => ({
      kind: "redactRetried" as const,
      instance: at,
      person,
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({ instance, person: fc.nat(8) })
      .map(({ instance: at, person }) => ({ kind: "touch" as const, instance: at, person })),
  },
  {
    weight: 1,
    arbitrary: instance.map((at) => ({ kind: "retainUncommitted" as const, instance: at })),
  },
  { weight: 4, arbitrary: instance.map((at) => ({ kind: "pass" as const, instance: at })) },
);

const round = fc.constantFrom<Round>("pass", "crash", "stop");

const besideAction: fc.Arbitrary<Beside> = fc.oneof(
  { weight: 6, arbitrary: instanceAction },
  { weight: 1, arbitrary: fc.constant({ kind: "prune" as const }) },
);

const actionOf = (): fc.Arbitrary<Action> =>
  fc.oneof(
    { weight: 12, arbitrary: instanceAction },
    { weight: 3, arbitrary: fc.constant({ kind: "tick" as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: "age" as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: "move" as const }) },
    { weight: 2, arbitrary: fc.constant({ kind: "prune" as const }) },
    {
      weight: 4,
      arbitrary: fc.nat(1).map((slot) => ({ kind: "backUp" as const, slot })),
    },
    {
      weight: 4,
      arbitrary: fc
        .record({ slot: fc.nat(1), round: fc.tuple(round, round) })
        .map(({ slot, round: chosen }) => ({ kind: "restore" as const, slot, round: chosen })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom<LedgerMode>("up", "down", "dropping", "commitsDown")
        .map((mode) => ({ kind: "ledger" as const, mode })),
    },
    { weight: 1, arbitrary: fc.constant({ kind: "release" as const }) },
    { weight: 2, arbitrary: instance.map((at) => ({ kind: "declare" as const, instance: at })) },
    {
      weight: 4,
      arbitrary: fc
        .tuple(besideAction, besideAction)
        .map(([first, second]) => ({ kind: "together" as const, first, second })),
    },
  );

const runModel = async (
  kind: "sql" | "kv",
  actions: readonly Action[],
  scheduler?: fc.Scheduler,
  lags: readonly number[] = [],
): Promise<ModelRun> => {
  const world = createWorld(kind, scheduler, lags);
  try {
    await world.run({ kind: "start", instance: 0 });
    for (const action of actions) await world.run(action);
    return await world.settle();
  } finally {
    await world.close();
  }
};

// Each run draws new traces. A failure prints its seed and its shrunk trace: `BOUNDA_MODEL_SEED`
// runs that seed again, `BOUNDA_MODEL_REPLAY='{"kind":"kv","actions":[…],"lags":[…]}'` the trace
// alone, with `BOUNDA_MODEL_LOG=1` for what the instances logged; pin it in `COUNTEREXAMPLES` once
// fixed. `BOUNDA_MODEL_RUNS` and `BOUNDA_MODEL_LENGTH` search wider: the traces of a run are a
// dozen actions long at most, as fast-check sizes them, and as long as `BOUNDA_MODEL_LENGTH` says
// at most when it is set.
const RUNS = Number(process.env.BOUNDA_MODEL_RUNS ?? 60);
const LENGTH = Number(process.env.BOUNDA_MODEL_LENGTH ?? 24);
const SIZE = process.env.BOUNDA_MODEL_LENGTH === undefined ? {} : { size: "max" as const };

describe("restore counting, against its model", () => {
  for (const kind of ["sql", "kv"] as const) {
    it(`counts every restore the observations prove, once, and nothing else (${kind} ledger)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionOf(), { minLength: 1, maxLength: LENGTH, ...SIZE }),
          fc.scheduler(),
          // How long each write to the KV ledger takes to show, in turn.
          fc.array(fc.nat(KV_DELAY_MS), { maxLength: 16, ...SIZE }),
          async (actions, scheduler, lags) => {
            const result = await runModel(kind, actions, scheduler, lags);
            expect(result.violations, result.trace.join("\n")).toEqual([]);
            expect(result.counted, result.trace.join("\n")).toBe(result.expected);
            if (result.answered)
              expect(result.stored, result.trace.join("\n")).toBe(result.counted);
          },
        ),
        {
          numRuns: RUNS,
          ...(process.env.BOUNDA_MODEL_SEED === undefined
            ? {}
            : { seed: Number(process.env.BOUNDA_MODEL_SEED) }),
        },
      );
    }, 600_000);
  }
});

// What the property found, each fixed in the runtime, or in the model where it read the runtime
// wrong, and kept here as it was found.
const restore = (slot: number, round: readonly [Round, Round]): Action => ({
  kind: "restore",
  slot,
  round,
});
const by = <Kind extends InstanceAction["kind"]>(
  kind: Kind,
  instance: Instance,
  person = 0,
): InstanceAction =>
  (kind === "forget" ||
  kind === "forgetUncommitted" ||
  kind === "forgetRetried" ||
  kind === "redactUncommitted" ||
  kind === "redactRetried" ||
  kind === "touch"
    ? { kind, instance, person }
    : { kind, instance }) as InstanceAction;

const COUNTEREXAMPLES: readonly {
  readonly name: string;
  readonly kind: "sql" | "kv";
  readonly actions: readonly Action[];
  // On KV, how long each write takes to show; the whole delay when left out.
  readonly lags?: readonly number[];
  readonly counted: number;
  // The count the database holds, when it is not every restore counted: a ledger that keeps the
  // highest count alone, which could not be read as an instance counted, let two restores take one
  // number.
  readonly stored?: number;
}[] = [
  {
    name: "counts a restore under the running app whose only witness stops before it looks again",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 0 },
      by("write", 0),
      by("start", 1),
      restore(0, ["stop", "stop"]),
    ],
    counted: 1,
  },
  {
    name: "counts a restore another instance's stop told the ledger of, at the next pass of one that saw nothing",
    kind: "sql",
    actions: [
      by("write", 0),
      by("start", 1),
      by("forgetUncommitted", 0),
      { kind: "backUp", slot: 0 },
      by("forget", 1),
      restore(0, ["pass", "stop"]),
    ],
    counted: 1,
  },
  {
    name: "counts once a restore found while the ledger took nothing, reconciled at a later start",
    kind: "sql",
    actions: [
      { kind: "ledger", mode: "dropping" },
      by("write", 0),
      { kind: "backUp", slot: 0 },
      by("forget", 0),
      restore(0, ["pass", "pass"]),
    ],
    counted: 1,
  },
  {
    name: "counts once a restore one instance counted and another, which saw its newest event go, stops after",
    kind: "sql",
    actions: [
      by("start", 1),
      by("write", 0),
      { kind: "backUp", slot: 1 },
      by("forget", 0),
      by("write", 1),
      restore(1, ["pass", "stop"]),
      { kind: "backUp", slot: 0 },
    ],
    counted: 1,
  },
  {
    name: "counts at start a restore that lost a forgetting committed a moment before, which a forgetting again would hide",
    kind: "kv",
    actions: [
      { kind: "together", first: by("pass", 0), second: by("write", 0) },
      { kind: "backUp", slot: 1 },
      by("forget", 0),
      restore(1, ["crash", "pass"]),
      by("start", 0),
      by("forget", 0),
    ],
    counted: 1,
  },
  {
    name: "counts every restore found, one counted on a copy a later restore took back included",
    kind: "sql",
    actions: [
      { kind: "together", first: by("start", 0), second: by("write", 0) },
      { kind: "backUp", slot: 0 },
      restore(0, ["pass", "pass"]),
      restore(0, ["pass", "pass"]),
      restore(0, ["crash", "pass"]),
    ],
    counted: 2,
  },
  {
    name: "counts a copy behind the mark though another restore was counted since the instance read",
    kind: "sql",
    actions: [
      { kind: "declare", instance: 1 },
      { kind: "backUp", slot: 0 },
      by("write", 0),
      { kind: "declare", instance: 1 },
      restore(0, ["pass", "pass"]),
    ],
    counted: 3,
  },
  {
    name: "counts a restore that lost a committed forgetting whose person an earlier intention forgot again first",
    kind: "sql",
    actions: [
      by("write", 0),
      { kind: "backUp", slot: 1 },
      by("forgetUncommitted", 0),
      { kind: "ledger", mode: "dropping" },
      by("forget", 0),
      restore(1, ["crash", "pass"]),
    ],
    counted: 1,
  },
  {
    name: "counts at start an intention written past the copy, though nobody is forgotten again, and a declaration after it nothing",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "together", first: by("write", 0), second: by("forgetUncommitted", 0) },
      restore(0, ["crash", "pass"]),
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 0 },
    ],
    counted: 1,
  },
  {
    name: "counts on KV a copy restored right after the mark passed it, once the reads show the mark, though the database wrote since",
    kind: "kv",
    actions: [
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      by("pass", 0),
      { kind: "backUp", slot: 0 },
      by("write", 0),
      { kind: "tick" },
      by("pass", 0),
      by("crash", 0),
      restore(0, ["pass", "pass"]),
      by("start", 0),
      by("write", 0),
      { kind: "tick" },
      by("pass", 0),
      { kind: "tick" },
      by("pass", 0),
    ],
    counted: 1,
  },
  {
    name: "counts on KV once a copy found at start behind a mark the reads showed, when a higher one raised before shows later",
    kind: "kv",
    actions: [
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      by("pass", 0),
      { kind: "backUp", slot: 1 },
      by("write", 0),
      { kind: "tick" },
      by("pass", 0),
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      by("write", 0),
      { kind: "tick" },
      by("pass", 0),
      by("write", 0),
      { kind: "tick" },
      by("pass", 0),
      by("crash", 0),
      restore(1, ["pass", "pass"]),
      by("start", 0),
      { kind: "tick" },
      { kind: "tick" },
      { kind: "tick" },
      by("pass", 0),
    ],
    counted: 1,
  },
  {
    name: "counts no declaration for a committed redaction a copy lost that an earlier intention, applied again, left nothing to seal of",
    kind: "sql",
    actions: [
      { kind: "together", first: { kind: "prune" }, second: by("write", 0) },
      { kind: "backUp", slot: 1 },
      by("redactRetried", 0),
      restore(1, ["pass", "pass"]),
      { kind: "declare", instance: 0 },
      restore(0, ["pass", "pass"]),
    ],
    counted: 1,
  },
  {
    name: "counts a declaration once the retention forgot anew after a pass handled the restore",
    kind: "sql",
    actions: [
      by("write", 0),
      { kind: "backUp", slot: 1 },
      { kind: "together", first: by("redactRetried", 0), second: by("redactRetried", 0) },
      { kind: "age" },
      restore(1, ["pass", "pass"]),
      { kind: "declare", instance: 0 },
      by("pass", 0),
    ],
    counted: 2,
  },
  {
    name: "proves nothing by a retention's forgetting a copy lost whose person the retention would not forget now",
    kind: "sql",
    actions: [
      by("write", 0),
      { kind: "age" },
      { kind: "backUp", slot: 1 },
      restore(1, ["pass", "pass"]),
      restore(1, ["crash", "pass"]),
      { kind: "declare", instance: 0 },
      by("stop", 0),
    ],
    counted: 1,
  },
  {
    name: "counts on KV a retention's forgetting a copy lost, written since the latest restore counted, though the ledger took it only later",
    kind: "kv",
    actions: [
      by("write", 0),
      { kind: "ledger", mode: "dropping" },
      { kind: "age" },
      { kind: "backUp", slot: 1 },
      { kind: "together", first: by("pass", 0), second: by("forgetUncommitted", 0) },
      restore(1, ["crash", "pass"]),
      { kind: "together", first: by("pass", 0), second: { kind: "prune" } },
    ],
    counted: 1,
  },
  {
    name: "counts on KV a declaration after one the reads do not show yet past it, in the database's count too",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      restore(1, ["crash", "pass"]),
      { kind: "declare", instance: 0 },
    ],
    counted: 2,
  },
  {
    name: "applies on KV, once the reads show it, a forgetting a restore found while running lost, and counts that restore once",
    kind: "kv",
    actions: [
      by("write", 0),
      { kind: "backUp", slot: 0 },
      by("forget", 0),
      restore(0, ["pass", "pass"]),
      { kind: "tick" },
      { kind: "tick" },
      by("pass", 0),
    ],
    counted: 1,
  },
  {
    name: "counts once on KV a restore found while running that lost a forgetting asked again, whose first intention its reads show after",
    kind: "kv",
    actions: [
      by("write", 0),
      { kind: "backUp", slot: 0 },
      by("forgetRetried", 0),
      restore(0, ["pass", "pass"]),
    ],
    counted: 1,
  },
  {
    name: "counts once on KV a copy restored back over the copy a crash left unlooked at, whose lost forgetting the first restore counted",
    kind: "kv",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "forget", instance: 0, person: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "backUp", slot: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts on KV a restore that lost a committed forgetting, once a start that could not read the ledger reads it on a pass",
    kind: "kv",
    actions: [
      { kind: "ledger", mode: "dropping" },
      { kind: "backUp", slot: 0 },
      { kind: "write", instance: 0 },
      { kind: "forget", instance: 0, person: 0 },
      { kind: "release" },
      { kind: "restore", slot: 0, round: ["stop", "pass"] },
      {
        kind: "together",
        first: { kind: "forget", instance: 0, person: 0 },
        second: { kind: "start", instance: 0 },
      },
      { kind: "age" },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts once on SQL a restore that lost a forgetting whose commit the ledger took only after the restore was counted and reconciled",
    kind: "sql",
    actions: [
      { kind: "ledger", mode: "dropping" },
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "forget", instance: 0, person: 0 },
      { kind: "ledger", mode: "commitsDown" },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "pass", instance: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts on KV a restore that lost a forgetting written after the latest restore counted, which no reconciliation had read through yet",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "ledger", mode: "dropping" },
      { kind: "write", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "backUp", slot: 1 },
      { kind: "write", instance: 0 },
      {
        kind: "together",
        first: { kind: "prune" },
        second: { kind: "forget", instance: 0, person: 0 },
      },
      { kind: "ledger", mode: "down" },
      { kind: "restore", slot: 1, round: ["stop", "pass"] },
      {
        kind: "together",
        first: { kind: "forgetRetried", instance: 0, person: 0 },
        second: { kind: "stop", instance: 0 },
      },
    ] as Action[],
    counted: 2,
  },
  {
    name: "tells on KV nothing more by an intention written, before the latest restore counted, where the database had gone further than it stands",
    kind: "kv",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "forget", instance: 0, person: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "forgetRetried", instance: 0, person: 0 },
      { kind: "restore", slot: 1, round: ["stop", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "pass", instance: 0 },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts once a restore one instance counted while the ledger could not be read, with the number a declaration the copy lacks took, which another instance joins",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 1 },
      { kind: "write", instance: 0 },
      { kind: "ledger", mode: "dropping" },
      { kind: "start", instance: 1 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "pass", instance: 0 },
      },
    ] as Action[],
    counted: 2,
    stored: 1,
  },
  {
    name: "counts a copy holding the count an instance read, counted earlier than the count it read",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "write", instance: 0 },
      { kind: "declare", instance: 1 },
      { kind: "ledger", mode: "dropping" },
      { kind: "backUp", slot: 1 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "touch", instance: 0, person: 0 },
    ] as Action[],
    counted: 3,
    stored: 2,
  },
  {
    name: "counts on KV a declaration on a copy of where handling a restore left the database, made before the reads show the restore counted since, once they show it",
    kind: "kv",
    actions: [
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "write", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "crash", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "forgetUncommitted", instance: 0, person: 0 },
    ] as Action[],
    counted: 3,
  },
  {
    name: "counts nothing on KV for a declaration made again before the reads show the recount it waits for, which leaves the database where handling the last restore left it",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["stop", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 0 },
    ] as Action[],
    lags: [0, 0, 3],
    counted: 2,
  },
  {
    name: "counts on KV a copy of where handling a declaration left the database, restored after another declaration took the same number",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 1, round: ["stop", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
    ] as Action[],
    counted: 3,
  },
  {
    name: "counts every copy that lacks a restore the database handled, whatever number its count took",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 1 },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "restore", slot: 0, round: ["stop", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "start", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
    ] as Action[],
    counted: 5,
  },
  {
    name: "proves nothing by what a stop raised past a generation a later copy holds again",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "start", instance: 1 },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "write", instance: 1 },
      { kind: "restore", slot: 0, round: ["crash", "stop"] },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "start", instance: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "proves nothing by an event the instance neither read nor committed",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 1 },
      {
        kind: "together",
        first: { kind: "start", instance: 1 },
        second: { kind: "forgetRetried", instance: 0, person: 0 },
      },
      { kind: "together", first: { kind: "write", instance: 0 }, second: { kind: "prune" } },
      {
        kind: "together",
        first: { kind: "forgetUncommitted", instance: 1, person: 0 },
        second: { kind: "prune" },
      },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "write", instance: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "proves nothing by what was written before a start while the ledger cannot be read",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["crash", "pass"] },
      { kind: "start", instance: 0 },
      { kind: "age" },
      { kind: "ledger", mode: "dropping" },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "tick" },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts a restore that lost a retention's forgetting written after the latest restore counted, nothing left to apply of it",
    kind: "sql",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 1 },
      {
        kind: "together",
        first: { kind: "pass", instance: 1 },
        second: { kind: "forgetUncommitted", instance: 0, person: 0 },
      },
      { kind: "age" },
      { kind: "ledger", mode: "dropping" },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "start", instance: 1 },
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "restore", slot: 0, round: ["pass", "crash"] },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
    ] as Action[],
    counted: 1,
  },
  {
    name: "proves nothing by a forgetting written before the latest restore counted, which the database lacks again",
    kind: "sql",
    actions: [
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "backUp", slot: 1 },
      {
        kind: "together",
        first: { kind: "forgetRetried", instance: 0, person: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "ledger", mode: "dropping" },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "crash", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "start", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "crash", instance: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts on KV a copy that lost the generation a declaration's wait moved, from what the instance read then",
    kind: "kv",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "pass", instance: 0 },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts a restore a pass finds by the forgetting its reconciliation reads, written after the latest restore counted",
    kind: "sql",
    actions: [
      { kind: "declare", instance: 1 },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "redactRetried", instance: 0, person: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "forget", instance: 0, person: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "tick" },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts on KV a copy from before a declaration, which holds no restore though the ledger shows one counted",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "restore", slot: 0, round: ["crash", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 0 },
    ] as Action[],
    lags: [3, 0],
    counted: 2,
  },
  {
    name: "moves on KV a copy taken before a recount to the count the recount moved to, counting no restore",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["crash", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "release" },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts a restore an instance joined as another's, by an intention written past the copy after that count, which its reconciliation reads before the generation moves",
    kind: "sql",
    actions: [
      { kind: "declare", instance: 1 },
      { kind: "backUp", slot: 1 },
      { kind: "write", instance: 0 },
      { kind: "redactUncommitted", instance: 0, person: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
    ] as Action[],
    counted: 2,
  },
  {
    name: "proves nothing by entries that land in the ledger later than a reconciliation reads again before its cursor",
    kind: "sql",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "ledger", mode: "dropping" },
      { kind: "backUp", slot: 0 },
      { kind: "redactRetried", instance: 0, person: 0 },
      { kind: "restore", slot: 0, round: ["stop", "pass"] },
      { kind: "start", instance: 0 },
      { kind: "age" },
      { kind: "ledger", mode: "up" },
      {
        kind: "together",
        first: { kind: "pass", instance: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "write", instance: 0 },
    ] as Action[],
    counted: 0,
  },
  {
    name: "counts once a restore that a mark raised before it was counted, which the ledger took only after, tells again",
    kind: "sql",
    actions: [
      {
        kind: "together",
        first: { kind: "write", instance: 0 },
        second: { kind: "forget", instance: 0, person: 0 },
      },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "pass", instance: 0 },
        second: { kind: "start", instance: 0 },
      },
      { kind: "ledger", mode: "dropping" },
      { kind: "restore", slot: 0, round: ["stop", "pass"] },
      { kind: "start", instance: 1 },
      {
        kind: "together",
        first: { kind: "pass", instance: 0 },
        second: { kind: "start", instance: 0 },
      },
      { kind: "write", instance: 1 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "ledger", mode: "up" },
    ] as Action[],
    counted: 1,
  },
  {
    name: "starts one instance at a time on KV, two starts asked at once included",
    kind: "kv",
    actions: [
      { kind: "crash", instance: 0 },
      {
        kind: "together",
        first: { kind: "start", instance: 1 },
        second: { kind: "start", instance: 0 },
      },
      { kind: "declare", instance: 0 },
      {
        kind: "together",
        first: { kind: "stop", instance: 1 },
        second: { kind: "pass", instance: 0 },
      },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "forgetRetried", instance: 0, person: 0 },
      },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts on KV past a recount a count its reads did not show, though it took a number below the recount's",
    kind: "kv",
    actions: [
      { kind: "stop", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "forget", instance: 0, person: 0 },
      },
    ] as Action[],
    counted: 4,
  },
  {
    name: "counts no copy by a count the ledger raised before the latest restore the database counted, which a count that took a number already counted left behind",
    kind: "sql",
    actions: [
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "declare", instance: 0 },
      { kind: "ledger", mode: "dropping" },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "start", instance: 0 },
      {
        kind: "together",
        first: { kind: "write", instance: 0 },
        second: { kind: "stop", instance: 0 },
      },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "pass", instance: 0 },
      },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      {
        kind: "together",
        first: { kind: "write", instance: 0 },
        second: { kind: "forget", instance: 0, person: 0 },
      },
    ] as Action[],
    counted: 3,
    stored: 1,
  },
  {
    name: "takes as read at a start what the database held when it began, beside another instance's commit",
    kind: "sql",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 1 },
      {
        kind: "together",
        first: { kind: "start", instance: 1 },
        second: { kind: "redactRetried", instance: 0, person: 0 },
      },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "forgetUncommitted", instance: 0, person: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts a declaration once a retention forgot anew before a round of reconciliation found the restore by the entries it read",
    kind: "sql",
    actions: [
      { kind: "start", instance: 1 },
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 0 },
      { kind: "forget", instance: 1, person: 0 },
      { kind: "age" },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "ledger", mode: "up" },
    ] as Action[],
    counted: 1,
  },
  {
    name: "waits out a reconciliation's hold after the database refused a commit before it applies what the ledger holds",
    kind: "kv",
    actions: [
      {
        kind: "together",
        first: { kind: "write", instance: 0 },
        second: { kind: "pass", instance: 0 },
      },
      { kind: "backUp", slot: 0 },
      { kind: "redactRetried", instance: 0, person: 0 },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "age" },
      { kind: "retainUncommitted", instance: 0 },
      { kind: "declare", instance: 0 },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts nothing on KV for a declaration where handling the last restore left the database, below a mark raised before that restore was counted",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 1 },
      { kind: "write", instance: 0 },
      { kind: "pass", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "age" },
    ] as Action[],
    lags: [2],
    counted: 2,
  },
  {
    name: "counts a restore by a forgetting the pass's own commit, appended again, lets its reconciliation read",
    kind: "sql",
    actions: [
      { kind: "ledger", mode: "commitsDown" },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "declare", instance: 1 },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "start", instance: 0 },
        second: { kind: "forget", instance: 0, person: 0 },
      },
      { kind: "ledger", mode: "up" },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "redactUncommitted", instance: 0, person: 0 },
    ] as Action[],
    counted: 2,
  },
  {
    name: "counts a restore by an intention written where the database held more events, though the generation moved since",
    kind: "sql",
    actions: [
      { kind: "together", first: { kind: "start", instance: 1 }, second: { kind: "prune" } },
      { kind: "age" },
      { kind: "write", instance: 0 },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "write", instance: 0 },
        second: { kind: "redactUncommitted", instance: 0, person: 0 },
      },
      { kind: "restore", slot: 0, round: ["crash", "pass"] },
      { kind: "move" },
    ] as Action[],
    counted: 1,
  },
  {
    name: "counts nothing on KV for a copy taken before a recount, which holds the count it corrected",
    kind: "kv",
    actions: [
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      { kind: "restore", slot: 1, round: ["crash", "pass"] },
      { kind: "declare", instance: 0 },
      { kind: "backUp", slot: 1 },
      { kind: "declare", instance: 0 },
      { kind: "start", instance: 0 },
      { kind: "restore", slot: 1, round: ["pass", "pass"] },
      { kind: "forgetUncommitted", instance: 0, person: 0 },
    ] as Action[],
    counted: 2,
  },
  {
    name: "proves nothing by a redaction's entry its own reconciliation committed, read as the intention it was",
    kind: "sql",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "declare", instance: 1 },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "redactUncommitted", instance: 0, person: 0 },
        second: { kind: "write", instance: 0 },
      },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
    ] as Action[],
    counted: 1,
  },
  {
    name: "applies, once the ledger takes it again, a forgetting a prune let go of before a restore lost it",
    kind: "sql",
    actions: [
      { kind: "write", instance: 0 },
      { kind: "ledger", mode: "dropping" },
      { kind: "backUp", slot: 0 },
      {
        kind: "together",
        first: { kind: "forget", instance: 0, person: 0 },
        second: { kind: "redactRetried", instance: 0, person: 0 },
      },
      { kind: "ledger", mode: "up" },
      { kind: "pass", instance: 0 },
      { kind: "prune" },
      { kind: "restore", slot: 0, round: ["pass", "pass"] },
      { kind: "prune" },
    ] as Action[],
    counted: 1,
  },
];

describe("restore counting, the counterexamples its model found", () => {
  for (const { name, kind, actions, lags, counted, stored = counted } of COUNTEREXAMPLES) {
    it(name, async () => {
      const result = await runModel(kind, actions, undefined, lags);
      const trace = result.trace.join("\n");
      expect(result.violations, trace).toEqual([]);
      expect(result.expected, trace).toBe(counted);
      expect(result.counted, trace).toBe(counted);
      expect(result.stored, trace).toBe(stored);
    });
  }

  // #321's case: a copy taken between an intention and its commit, the ledger down from the commit
  // until the instance is gone, restored; and a commit that failed. Each leaves the same database
  // and the same ledger, and one went back where the other did not: neither is counted.
  it("confirms a copy taken before a commit the ledger never saw is a commit that failed, to every look", async () => {
    // As many actions each, so both take as long.
    const betweens: readonly (readonly Action[])[] = [
      [{ kind: "ledger", mode: "commitsDown" }, by("forget", 0)],
      [{ kind: "ledger", mode: "up" }, by("forgetUncommitted", 0)],
    ];
    const worlds = await Promise.all(
      betweens.map(async (between) => {
        const world = createWorld("sql");
        try {
          for (const action of [
            by("start", 0),
            by("write", 0),
            { kind: "backUp", slot: 0 } as const,
            ...between,
            by("crash", 0),
            { kind: "ledger", mode: "up" } as const,
            restore(0, ["pass", "pass"]),
          ]) {
            await world.run(action);
          }
          const observed = await world.observe();
          const truth = world.truth();
          const { counted, expected } = await world.settle();
          return { observed, truth, counted, expected };
        } finally {
          await world.close();
        }
      }),
    );
    const [restored, failed] = worlds;
    expect(restored?.observed).toBe(failed?.observed);
    expect([restored?.truth, failed?.truth]).toEqual([1, 0]);
    expect(worlds.map(({ counted, expected }) => [counted, expected])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("pruning the ledger with no app, against the model", () => {
  it("keeps what a copy restored while no instance ran lacks until a start applies it, then removes it", async () => {
    const world = createWorld("sql");
    try {
      const steps: readonly Action[] = [
        by("start", 0),
        by("write", 0),
        { kind: "backUp", slot: 0 },
        by("forget", 0),
        by("stop", 0),
        { kind: "tick" },
        restore(0, ["pass", "pass"]),
        { kind: "prune" },
      ];
      for (const step of steps) await world.run(step);
      expect((await world.entries()).map(({ committed }) => committed)).toEqual([undefined]);
      for (const step of [by("start", 0), by("pass", 0), { kind: "prune" } as const]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([1, 1]);
    } finally {
      await world.close();
    }
  });
});

describe("pruning intentions nothing applies with no app, against the model", () => {
  it("keeps an intention while its person holds a key it names, and removes it once they hold none", async () => {
    const world = createWorld("sql");
    try {
      for (const step of [
        by("start", 0),
        by("write", 0),
        by("forgetUncommitted", 0),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect((await world.entries()).map(({ committed }) => committed)).toEqual([false]);
      for (const step of [
        by("forgetRetried", 0),
        by("stop", 0),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([0, 0]);
    } finally {
      await world.close();
    }
  });

  it("keeps an intention written past a copy restored while no instance ran, whose person the copy never held", async () => {
    const world = createWorld("sql");
    try {
      for (const step of [
        by("start", 0),
        by("write", 0),
        { kind: "backUp", slot: 0 } as const,
        by("write", 0),
        by("forgetUncommitted", 0, 1),
        by("stop", 0),
        restore(0, ["pass", "pass"]),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([
        expect.objectContaining({ personId: "p2", committed: false }),
      ]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([1, 1]);
    } finally {
      await world.close();
    }
  });
});

describe("pruning, with the app's registry, what only the app decides, against the model", () => {
  it("keeps a redaction's intention while it would seal a value, and removes it once redacted", async () => {
    const world = createWorld("sql");
    try {
      for (const step of [
        by("start", 0),
        by("write", 0),
        by("redactUncommitted", 0),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([
        expect.objectContaining({ personId: "p1", committed: false, redaction: expect.anything() }),
      ]);
      for (const step of [
        by("redactRetried", 0),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([0, 0]);
    } finally {
      await world.close();
    }
  });

  it("keeps a retention's intention while the retention would forget its person, and removes it once they are active again", async () => {
    const world = createWorld("sql");
    try {
      for (const step of [
        by("start", 0),
        by("write", 0),
        { kind: "age" } as const,
        by("retainUncommitted", 0),
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([
        expect.objectContaining({ personId: "p1", committed: false, reason: "retention" }),
      ]);
      for (const step of [by("touch", 0), by("pass", 0), { kind: "prune" } as const]) {
        await world.run(step);
      }
      expect(await world.entries()).toEqual([]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([0, 0]);
    } finally {
      await world.close();
    }
  });

  it("keeps in the store the ledger left what a copy restored lacks, until the database holds it", async () => {
    const world = createWorld("sql");
    try {
      for (const step of [
        by("start", 0),
        by("write", 0),
        { kind: "backUp", slot: 0 } as const,
        by("forget", 0),
        { kind: "move" } as const,
        by("stop", 0),
        restore(0, ["pass", "pass"]),
        { kind: "tick" } as const,
        { kind: "prune" } as const,
      ]) {
        await world.run(step);
      }
      expect((await world.formerEntries()).map(({ personId }) => personId)).toEqual(["p1"]);
      for (const step of [by("start", 0), by("pass", 0), { kind: "prune" } as const]) {
        await world.run(step);
      }
      expect(await world.formerEntries()).toEqual([]);
      const { violations, counted, expected } = await world.settle();
      expect(violations).toEqual([]);
      expect([counted, expected]).toEqual([1, 1]);
    } finally {
      await world.close();
    }
  });
});

describe.runIf(process.env.BOUNDA_MODEL_REPLAY !== undefined)("a counterexample replayed", () => {
  it("counts as the model says", async () => {
    const { kind, actions, lags } = JSON.parse(process.env.BOUNDA_MODEL_REPLAY ?? "{}") as {
      kind: "sql" | "kv";
      actions: Action[];
      lags?: number[];
    };
    const result = await runModel(kind, actions, undefined, lags);
    expect(result.violations, result.trace.join("\n")).toEqual([]);
    expect(result.counted, result.trace.join("\n")).toBe(result.expected);
    if (result.answered) expect(result.stored, result.trace.join("\n")).toBe(result.counted);
  });
});
