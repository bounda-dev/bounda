import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type {
  ForgetLedger,
  ForgetLedgerEntry,
  ForgetLedgerMark,
  PruneForgetLedgerArgs,
  ReadForgetLedgerArgs,
} from "../../adapter/storage/forget-ledger.ts";
import { createFixedClock, type FixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { createEphemeralKeys } from "../personal-data/ephemeral-keys.ts";
import { defineForgetLedger } from "../personal-data/forget-ledger.ts";
import { pruneAsApplied } from "../personal-data/ledger-prune.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_GRACE_MS,
  FORGET_LEDGER_REREAD_MS,
} from "../personal-data/reconciliation.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import {
  GENERATION_INTERVAL_MS,
  RESTORE_COVERED,
  RESTORE_GENERATION,
  RESTORE_MARK,
  RESTORES_FOUND,
} from "./restores.ts";

// The model of restore counting, and a property that walks interleavings of what can happen to a
// database, its forget ledger, backups and two instances, comparing what the runtime counts with
// what the model says it must.
//
// What is true: a restore puts back a copy; it goes back when the copy lacks an event the database
// held, or holds a lower generation or count. Restores the app touched nothing in between are one
// going back, which is all it can ever tell. What is observable: the database, the ledger (marks,
// committed entries, intentions with where the database stood) and what each running instance read
// or committed. A going back is proved, at a look that reads it, by:
//   - the ledger's mark above the database's generation, which a pass and a start read;
//   - a committed entry whose event the database lacks, of a person it still holds or written where
//     the database still stands, which a start reads;
//   - an entry written where the database had gone further than it now stands, which a start reads;
//   - what an instance running when the copy came back read or committed past it, which its own
//     next pass reads, or its stop leaves in the ledger when the ledger takes it: a generation past
//     the copy's, a count past it, or its newest event gone while the count stayed as it read it.
// Each look must count, once, a going back it proves; one nothing proves reads the same as a
// database that never went back, and counts nothing. An operator's declaration counts unless the
// database stands where handling the last restore left it and nothing proves another; the operator
// then says `again` for a copy. The runtime's count is how many restores an instance handled first,
// and, while the ledger took every count, the count the database holds.
//
// An operator prunes the ledger with no app (`bounda forget-ledger prune`), at any moment, with a
// `keepFor` of nothing, so only what the database has applied bounds it: what the ledger proves of
// the database must read the same after a prune as before, and a prune removes only entries the
// database holds the event of or will not read again, and intentions nothing can apply: the person
// holds no key they name, and the database stands where they were written or further.

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
  | { readonly kind: "pass"; readonly instance: Instance };

// What happens beside the instances, as the operator's prune does.
type Beside = InstanceAction | { readonly kind: "prune" };

type Action =
  | InstanceAction
  | { readonly kind: "prune" }
  | { readonly kind: "tick" }
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
  // Who the database holds a key for, unforgotten.
  readonly holding: ReadonlySet<string>;
}

interface Copy {
  readonly rows: Rows;
  readonly snapshot: Snapshot;
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

// A value raised under a mark, when, and when it landed in the store.
interface RaisedMark extends ForgetLedgerMark {
  readonly landed: number;
}

// A ledger as a remote store is: down, down for committed copies alone, or taking writes it lands
// only later, as a call given up for its timeout does. A mark only ever goes up, whoever raises it.
// Workers KV keeps every value raised under a mark, and a read shows those that landed at least
// `KV_DELAY_MS` ago, the most a read may lag, and none younger.
const createModelLedger = (kind: "sql" | "kv", gate: () => Promise<void>, now: () => number) => {
  const inner = createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);
  const marks = new Map<string, RaisedMark[]>();
  const shown = (raised: RaisedMark): boolean => raised.landed <= now() - KV_DELAY_MS;
  const highestOf = (name: string, filter: (raised: RaisedMark) => boolean = () => true): number =>
    (marks.get(name) ?? [])
      .filter(filter)
      .reduce((highest, { value }) => Math.max(highest, value), 0);
  let mode: LedgerMode = "up";
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
  const byValue = (a: ForgetLedgerMark, b: ForgetLedgerMark): number =>
    b.value - a.value || Date.parse(a.raisedAt) - Date.parse(b.raisedAt);
  const ledger: ForgetLedger = {
    // Workers KV lists a key within the delay: the app reads the ledger once more after it.
    ...(kind === "kv" ? { visibilityDelayMs: KV_DELAY_MS } : {}),
    append: (entries) =>
      mode === "commitsDown" && entries.some(({ committed }) => committed !== false)
        ? gate().then(refuse)
        : write(() => inner.append(entries)),
    read: async (args: ReadForgetLedgerArgs) => {
      await reading();
      return inner.read(args);
    },
    readMark: async (name) => {
      await reading();
      const raised = marks.get(name) ?? [];
      if (kind === "sql") {
        const [highest] = [...raised].sort(byValue);
        return highest === undefined ? [] : [{ value: highest.value, raisedAt: highest.raisedAt }];
      }
      return raised
        .filter(shown)
        .map(({ value, raisedAt }) => ({ value, raisedAt }))
        .sort(byValue);
    },
    raiseMark: (name, { value, raisedAt }) =>
      write(async () => {
        const raised = marks.get(name) ?? [];
        marks.set(name, raised);
        if (raised.some((kept) => kept.value === value && kept.raisedAt === raisedAt)) return;
        // A ledger that reads what was written keeps the highest value, raised first.
        if (kind === "sql" && value <= highestOf(name)) return;
        if (kind === "sql") raised.length = 0;
        raised.push({ value, raisedAt, landed: now() });
      }),
    ...(kind === "kv"
      ? {
          pruneMarks: async (name: string, before: string) => {
            await reading();
            const raised = marks.get(name) ?? [];
            const [highest] = raised.filter((kept) => kept.raisedAt < before).sort(byValue);
            marks.set(
              name,
              raised.filter((kept) => kept === highest || kept.raisedAt >= before),
            );
          },
        }
      : {}),
    clear: () => inner.clear(),
    fence: inner.fence,
    // Workers KV expires its keys on its own: only the SQL ledger is pruned.
    ...(kind === "sql"
      ? {
          prune: (args: PruneForgetLedgerArgs) =>
            write(() => inner.prune?.(args) ?? Promise.resolve()),
        }
      : {}),
  };
  return {
    ledger,
    mark: (): number => highestOf(RESTORE_MARK),
    // What every read shows of the mark, raised from `after` on, or all that was.
    pointsFrom: (after: number, shownOnly: boolean): readonly ForgetLedgerMark[] =>
      (marks.get(RESTORE_MARK) ?? []).filter(
        (raised) => (!shownOnly || shown(raised)) && Date.parse(raised.raisedAt) >= after,
      ),
    marks: (): readonly (readonly [string, readonly ForgetLedgerMark[]])[] =>
      [...marks]
        .map(
          ([name, raised]) =>
            [
              name,
              raised.map(({ value, raisedAt }) => ({ value, raisedAt })).sort(byValue),
            ] as const,
        )
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    entries: (): Promise<readonly ForgetLedgerEntry[]> =>
      inner.read({ limit: Number.MAX_SAFE_INTEGER }),
    mode: (): LedgerMode => mode,
    set: (next: LedgerMode): void => {
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
  readonly witness: EventRow | null;
}

interface Live {
  readonly app: BoundaApp<Registry>;
  readonly clock: FixedClock;
  readonly prefix: string;
  readonly startedAt: number;
  // On KV, whether the marks raised before it started proved more than its reads showed then: what
  // it counts once they show every one.
  owed: boolean;
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

const createWorld = (kind: "sql" | "kv", scheduler?: fc.Scheduler) => {
  // While two instances act at once, the scheduler decides in which order each call to the ledger
  // answers.
  let interleaving = false;
  const gate = async (): Promise<void> => {
    if (interleaving && scheduler !== undefined) await scheduler.schedule(Promise.resolve());
  };
  const { adapter, db } = createNodeSqliteAdapter(":memory:");
  const keys = createEphemeralKeys();
  const ledger = createModelLedger(kind, gate, () => now);
  const definition = defineForgetLedger(() => ledger.ledger);
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
    // Whether one of them stopped since, leaving what it remembered in the ledger.
    carried: boolean;
    carrying: boolean;
  }
  let open: Episode[] = [];
  // The restores since the app last touched the database: the database the first replaced, and
  // the going back they make, if any.
  let unlooked: { replaced: Snapshot; episode: Episode | null } | null = null;
  let expected = 0;
  // How many times the database truly went back, as the model sees it.
  let goingBacks = 0;

  const logger = (): Logger => {
    const at =
      (level: string) =>
      (message: string, fields?: LogFields): void => {
        if (message === RESTARTED && fields?.first === true) firsts += 1;
        if (process.env.BOUNDA_MODEL_LOG === "1") {
          trace.push(
            `  ! ${level} ${message} ${JSON.stringify(fields, (key, value) => (key === "error" ? String(value) : value))}`,
          );
        }
      };
    return { ...silentLogger, warn: at("warn"), error: at("error") };
  };

  const memoryOf = (prefix: string | null): Memory => {
    const snapshot = snapshotOf(db);
    const own =
      prefix === null
        ? snapshot.events.at(-1)
        : snapshot.events.filter(({ id }) => id.startsWith(prefix)).at(-1);
    return {
      generation: snapshot.generation,
      restores: snapshot.restores,
      witness: own ?? snapshot.events.at(-1) ?? null,
    };
  };

  // What a running instance read or committed that the copy lacks.
  // A count past what it read was moved by another instance, which counted a restore of a copy
  // without its newest event as well as one taken after: the event lost tells it nothing more.
  const remembers = (memory: Memory, copy: Snapshot): boolean => {
    if (memory.generation > copy.generation || memory.restores > copy.restores) return true;
    const { witness } = memory;
    if (witness === null || memory.restores < copy.restores) return false;
    return copy.events.find(({ position }) => position === witness.position)?.id !== witness.id;
  };

  const wentBack = (replaced: Snapshot, copy: Snapshot): boolean =>
    copy.generation < replaced.generation ||
    copy.restores < replaced.restores ||
    replaced.events.some(
      ({ id, position }) => copy.events.find((event) => event.position === position)?.id !== id,
    );

  // What the ledger proves of the database as it now stands, for a look that reads it.
  // What the mark proves of the database: past its generation, on a ledger that reads what was
  // written. On KV, of what was raised since the latest restore counted, a value past it or one
  // raised before a lower one, the database having held it and then less; what every read shows
  // of it, and nothing before the instance's reads show every mark raised before it started.
  const markProves = (view: MarkView, generation: number): boolean => {
    if (kind === "sql" || view === "all") return ledger.mark() > generation;
    if (view === "none") return false;
    const points = ledger.pointsFrom(rowOf(db, RESTORE_COVERED), view === "shown");
    return points.some(({ value }) => value > generation) || droppedIn(points);
  };

  const ledgerProves = async (entries: boolean, view: MarkView = "shown"): Promise<boolean> => {
    if (ledger.mode() === "down" || ledger.mode() === "dropping") return false;
    const current = snapshotOf(db);
    if (markProves(view, current.generation)) return true;
    if (!entries) return false;
    const held = new Set(current.events.map(({ id }) => id));
    const last = current.events.at(-1)?.position ?? 0;
    for (const entry of await ledger.entries()) {
      const reached = entry.reached;
      // A committed entry whose event the database lacks, that a reconciliation commits again or
      // that was written where the database still stands: one a restore counted since lost is
      // that restore's.
      if (
        entry.committed !== false &&
        !held.has(entry.eventId) &&
        (current.holding.has(entry.personId) ||
          (reached !== undefined && reached.generation >= current.generation))
      ) {
        return true;
      }
      if (
        reached !== undefined &&
        (reached.generation > current.generation ||
          (reached.generation === current.generation && reached.position > last))
      ) {
        return true;
      }
    }
    return false;
  };

  // Where the database stood once the last restore counted was handled: its newest event, and the
  // restores it counted, which a copy taken before holds fewer of.
  interface Handled {
    readonly head: EventRow | null;
    readonly restores: number;
  }
  let handled: Handled | undefined;
  const headNow = (): Handled => {
    const snapshot = snapshotOf(db);
    return { head: snapshot.events.at(-1) ?? null, restores: snapshot.restores };
  };
  const standsWhereHandled = (): boolean => {
    const { head, restores } = headNow();
    return (
      handled !== undefined &&
      head?.id === handled.head?.id &&
      head?.position === handled.head?.position &&
      restores === handled.restores
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
    if (kindOfLook === "pass" && live?.owed === true && viewOf(live) === "shown") {
      return "the marks raised before its start, once its reads show them";
    }
    // On KV, what a stop left is a mark, which the reads show as the ledger's.
    if (
      kind === "sql" &&
      (ledger.mode() === "up" || ledger.mode() === "commitsDown") &&
      open.some(({ carried }) => carried)
    ) {
      return "what a stop left in the ledger";
    }
    const view = kindOfLook === "start" ? "shown" : viewOf(live ?? null);
    return (await ledgerProves(kindOfLook === "start", view)) ? "the ledger" : null;
  };

  // What a running instance compares of the mark: on KV, nothing before its reads show every mark
  // raised before it started.
  const viewOf = (live: Live | null): MarkView =>
    live !== null && now >= live.startedAt + KV_DELAY_MS ? "shown" : "none";

  const looked = (proof: string | null): void => {
    unlooked = null;
    if (proof !== null) proved(proof);
  };

  const startInstance = async (instance: Instance): Promise<void> => {
    if (instances[instance] !== null) return;
    // A Durable Object, the one app a KV ledger serves, runs once at a time.
    if (kind === "kv" && instances.some((live) => live !== null)) return;
    started += 1;
    const prefix = `i${instance}s${started}-`;
    const startedAt = now;
    const proof = await proofFor(instance, "start");
    // What the whole of the marks raised since the latest restore counted proves, the reads may not
    // show yet: the start compares them once they do.
    const owed =
      kind === "kv" &&
      proof === null &&
      open.length > 0 &&
      ledger.mode() !== "down" &&
      ledger.mode() !== "dropping" &&
      markProves("whole", snapshotOf(db).generation);
    const clock = createFixedClock(new Date(now));
    const app = await createApp<Registry>({
      registry,
      config: {
        storage: adapter,
        runtime: {
          personalData: {
            keyWrapper: keys.keyWrapper,
            tenantKeys: keys.tenantKeys,
            forgetLedger: { store: definition, reconcileEvery: RECONCILE_EVERY_MS },
          },
          policies: { retry: { strategy: "none" } },
        },
      },
      env: {},
      ids: createSequentialIdGenerator({ prefix }),
      clock,
      logger: logger(),
    });
    const live: Live = { app, clock, prefix, startedAt, owed, memory: memoryOf(null) };
    instances[instance] = live;
    looked(proof);
    if (settledAfter) handled = headNow();
    settledAfter = false;
    live.memory = memoryOf(null);
  };

  const pass = async (instance: Instance): Promise<void> => {
    const live = instances[instance];
    if (live === null || live === undefined) return;
    const proof = await proofFor(instance, "pass");
    await live.app.runUntilIdle();
    looked(proof);
    if (settledAfter) handled = headNow();
    settledAfter = false;
    live.memory = memoryOf(null);
  };

  const holdingNow = (): readonly string[] => [...snapshotOf(db).holding].sort();

  const failNextCommit = (): void => {
    db.exec(
      `CREATE TEMP TRIGGER IF NOT EXISTS "model_fail_commit" BEFORE INSERT ON main."bounda_events" BEGIN SELECT RAISE(ABORT, 'the commit failed'); END`,
    );
  };
  const commitAgain = (): void => {
    db.exec(`DROP TRIGGER IF EXISTS temp."model_fail_commit"`);
  };

  // The operator's prune, with no app, at the model's time.
  const prune = async (): Promise<void> => {
    const { prune: removes } = ledger.ledger;
    if (removes === undefined) return;
    const storage = await adapter.createStorage();
    try {
      await pruneAsApplied({
        ledger: { read: ledger.ledger.read, fence: ledger.ledger.fence, prune: removes },
        forgotten: async () => false,
        withStorage: (work) => work(storage),
        keepForMs: 0,
        now: new Date(now),
      });
    } catch {
      // The ledger is down, or takes the prune only later.
    } finally {
      await storage.close();
    }
  };

  // An intention whose commit the database lacks that nothing applies: the person holds no key it
  // names, kept past a forgetting or not, and the database stands where it was written or further.
  const inapplicable = (entry: ForgetLedgerEntry): boolean => {
    if (entry.committed !== false) return false;
    const { reached } = entry;
    const now = snapshotOf(db);
    const last = now.events.at(-1)?.position ?? 0;
    if (
      reached !== undefined &&
      (reached.generation > now.generation ||
        (reached.generation === now.generation && reached.position > last))
    ) {
      return false;
    }
    const keys = (
      db
        .prepare(`SELECT "fingerprint" FROM "bounda_personal_keys" WHERE "person" = ?`)
        .all(entry.personId) as { fingerprint: string }[]
    ).map(({ fingerprint }) => fingerprint);
    return !keys.some((fingerprint) => entry.fingerprints?.includes(fingerprint) ?? true);
  };

  // A prune nothing runs beside: it changes nothing a look reads.
  const pruneAlone = async (): Promise<void> => {
    const entries = await ledger.entries();
    const proves = await ledgerProves(true, "all");
    const cursor = rowOf(db, FORGET_LEDGER_CURSOR);
    const held = new Set(snapshotOf(db).events.map(({ id }) => id));
    await prune();
    const left = new Set((await ledger.entries()).map(({ eventId }) => eventId));
    for (const entry of entries) {
      if (left.has(entry.eventId) || held.has(entry.eventId) || inapplicable(entry)) continue;
      if (cursor === 0 || Date.parse(entry.forgottenAt) >= cursor - FORGET_LEDGER_REREAD_MS) {
        violations.push(`the prune removed ${entry.eventId}, which the database has yet to apply`);
      }
    }
    if ((await ledgerProves(true, "all")) !== proves) {
      violations.push(`the prune changed what the ledger proves from ${proves}`);
    }
  };

  const beside = (action: Beside): Promise<void> =>
    action.kind === "prune" ? prune() : instanceAction(action);

  const instanceAction = async (action: InstanceAction): Promise<void> => {
    const live = instances[action.instance];
    // What an instance writes in between makes a restore after it another going back.
    if (live != null || action.kind === "start") unlooked = null;
    switch (action.kind) {
      case "start":
        return startInstance(action.instance);
      case "pass":
        return pass(action.instance);
      case "stop":
        if (live === null || live === undefined) return;
        instances[action.instance] = null;
        // What it remembers goes to the ledger, unless the ledger takes nothing now.
        for (const episode of open) {
          if (!episode.remembered.has(live)) continue;
          if (ledger.mode() === "up" || ledger.mode() === "commitsDown") episode.carried = true;
          if (ledger.mode() === "dropping") episode.carrying = true;
        }
        await live.app.stop();
        return;
      case "crash":
        instances[action.instance] = null;
        return;
      case "write": {
        if (live === null || live === undefined) return;
        persons += 1;
        await live.app.commands.registerCustomer?.({
          customerId: `p${persons}`,
          email: `p${persons}@example.com`,
        });
        live.memory = { ...live.memory, witness: memoryOf(live.prefix).witness };
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
        live.memory = { ...live.memory, witness: memoryOf(live.prefix).witness };
        return;
      }
    }
  };

  const describeAction = (action: Action): string => JSON.stringify(action);

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
      case "backUp":
        // Nothing to copy before the first start creates the tables.
        if (tablesOf(db).length === 0) return;
        backups.set(action.slot, { rows: rowsOf(db), snapshot: snapshotOf(db) });
        return;
      case "restore": {
        const copy = backups.get(action.slot);
        if (copy === undefined) return;
        const replaced = unlooked?.replaced ?? snapshotOf(db);
        putBack(db, copy.rows);
        const goes = wentBack(replaced, copy.snapshot);
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
            carried: before?.carried ?? false,
            carrying: before?.carrying ?? false,
          };
          open.push(episode);
          if (before === undefined) goingBacks += 1;
        } else if (before !== undefined) goingBacks -= 1;
        unlooked = { replaced, episode };
        // Every instance running looks, stops or is gone before anything else happens.
        for (const instance of INSTANCES) {
          const round = action.round[instance];
          if (instances[instance] === null) continue;
          if (round === "pass") await pass(instance);
          else await instanceAction({ kind: round, instance });
        }
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
        const provable =
          (kind === "sql" && open.some(({ carried }) => carried)) ||
          (await ledgerProves(true, transient ? "none" : viewOf(live)));
        const stands = standsWhereHandled();
        try {
          const first = await live.app.restored();
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
            handled = headNow();
            live.memory = memoryOf(null);
            trace.push("    declared");
          }
        } catch {
          trace.push("    declaration refused");
        }
        if (transient) await instanceAction({ kind: "stop", instance: action.instance });
        return;
      }
      case "release":
        await ledger.release();
        for (const episode of open) episode.carried ||= episode.carrying;
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
        if (scheduler === undefined) {
          await Promise.all([beside(first), beside(second)]);
          return;
        }
        interleaving = true;
        try {
          await scheduler.waitFor(Promise.all([beside(first), beside(second)]));
        } finally {
          interleaving = false;
        }
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

  return { run, settle, close, observe, truth: () => goingBacks, entries: ledger.entries };
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
): Promise<ModelRun> => {
  const world = createWorld(kind, scheduler);
  try {
    await world.run({ kind: "start", instance: 0 });
    for (const action of actions) await world.run(action);
    return await world.settle();
  } finally {
    await world.close();
  }
};

// Each run draws new traces. A failure prints its seed and its shrunk trace: `BOUNDA_MODEL_SEED`
// runs that seed again, `BOUNDA_MODEL_REPLAY='{"kind":"kv","actions":[…]}'` the trace alone, with
// `BOUNDA_MODEL_LOG=1` for what the instances logged; pin it in `COUNTEREXAMPLES` once fixed.
// `BOUNDA_MODEL_RUNS` and `BOUNDA_MODEL_LENGTH` search wider.
const RUNS = Number(process.env.BOUNDA_MODEL_RUNS ?? 60);
const LENGTH = Number(process.env.BOUNDA_MODEL_LENGTH ?? 24);

describe("restore counting, against its model", () => {
  for (const kind of ["sql", "kv"] as const) {
    it(`counts every restore the observations prove, once, and nothing else (${kind} ledger)`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionOf(), { minLength: 1, maxLength: LENGTH }),
          fc.scheduler(),
          async (actions, scheduler) => {
            const result = await runModel(kind, actions, scheduler);
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

// What the property found, each fixed in the runtime and kept here as it was found.
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
  (kind === "forget" || kind === "forgetUncommitted" || kind === "forgetRetried"
    ? { kind, instance, person }
    : { kind, instance }) as InstanceAction;

const COUNTEREXAMPLES: readonly {
  readonly name: string;
  readonly kind: "sql" | "kv";
  readonly actions: readonly Action[];
  readonly counted: number;
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
];

describe("restore counting, the counterexamples its model found", () => {
  for (const { name, kind, actions, counted } of COUNTEREXAMPLES) {
    it(name, async () => {
      const result = await runModel(kind, actions);
      const trace = result.trace.join("\n");
      expect(result.violations, trace).toEqual([]);
      expect(result.expected, trace).toBe(counted);
      expect(result.counted, trace).toBe(counted);
      expect(result.stored, trace).toBe(counted);
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

describe.runIf(process.env.BOUNDA_MODEL_REPLAY !== undefined)("a counterexample replayed", () => {
  it("counts as the model says", async () => {
    const { kind, actions } = JSON.parse(process.env.BOUNDA_MODEL_REPLAY ?? "{}") as {
      kind: "sql" | "kv";
      actions: Action[];
    };
    const result = await runModel(kind, actions);
    expect(result.counted, result.trace.join("\n")).toBe(result.expected);
  });
});
