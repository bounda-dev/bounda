import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { EphemeralKeys } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ForgetLedgerMark } from "../../adapter/storage/forget-ledger.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { RestoreUnreconciledError } from "../../contracts/errors.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataForgottenPayload } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { PERSONAL_DATA_ACCESSED } from "../personal-data/access.ts";
import { createEphemeralKeys } from "../personal-data/ephemeral-keys.ts";
import { defineForgetLedger } from "../personal-data/forget-ledger.ts";
import { TENANT_CHECK_INTERVAL_MS } from "../personal-data/forgotten-tenant.ts";
import { HOLD_MAX_MS } from "../personal-data/hold.ts";
import { FORGET_LEDGER_GRACE_MS } from "../personal-data/reconciliation.ts";
import { ROTATION_CHECK_INTERVAL_MS } from "../personal-data/rotation.ts";
import type { TenantExportPart } from "../personal-data/tenant-export.ts";
import { DEFAULT_TENANT } from "../personal-data/tenant-keys.ts";
import { advanceUntilWaiting } from "../test-support.ts";
import {
  GENERATION_INTERVAL_MS,
  RESTORE_DECLARING,
  RESTORE_MARK,
  RESTORES_FOUND,
} from "./restores.ts";

const START = new Date("2026-04-01T00:00:00.000Z");

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

type Copy = ReadonlyMap<string, readonly Record<string, SQLInputValue>[]>;

// The Bounda tables as they are now, and putting them back while the app runs: what restoring a
// backup in place does to the instances still connected.
const copyOf = (db: DatabaseSync): Copy =>
  new Map(
    (
      db
        .prepare(
          `SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" LIKE 'bounda_%'`,
        )
        .all() as { name: string }[]
    ).map(({ name }) => [
      name,
      db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, SQLInputValue>[],
    ]),
  );

const restore = (db: DatabaseSync, copy: Copy): void => {
  db.exec("BEGIN IMMEDIATE");
  for (const table of copy.keys()) db.exec(`DELETE FROM "${table}"`);
  for (const [table, rows] of copy) {
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT OR IGNORE INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => row[column] ?? null));
    }
  }
  db.exec("COMMIT");
};

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly fields?: LogFields | undefined;
}

const recordingLogger = (): Logger & { readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const at = (level: string) => (message: string, fields?: LogFields) => {
    logged.push({ level, message, fields });
  };
  return { logged, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
};

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

let started = 0;

// The keys of each database, the same for every app the test starts over it, by its file.
const keysOf = new Map<unknown, EphemeralKeys>();
const keysFor = (adapter: { readonly options: unknown }): EphemeralKeys => {
  const { path } = adapter.options as { readonly path: string };
  const database = path === ":memory:" ? adapter : path;
  const known = keysOf.get(database);
  if (known !== undefined) return known;
  const created = createEphemeralKeys();
  keysOf.set(database, created);
  return created;
};

const start = async (args: {
  readonly adapter: ReturnType<typeof createNodeSqliteAdapter>["adapter"];
  readonly runtime?: RuntimeConfig;
  readonly env?: Record<string, string>;
  readonly logger?: Logger;
  readonly now?: Date;
}): Promise<{ app: BoundaApp<Registry>; clock: ReturnType<typeof createFixedClock> }> => {
  started += 1;
  const clock = createFixedClock(args.now ?? START);
  const { keyWrapper, tenantKeys } = keysFor(args.adapter);
  const app = await createApp<Registry>({
    registry,
    config: {
      storage: args.adapter,
      runtime: {
        ...args.runtime,
        personalData: { keyWrapper, tenantKeys, ...args.runtime?.personalData },
      },
    },
    env: args.env ?? {},
    ids: createSequentialIdGenerator({ prefix: `app-${started}` }),
    clock,
    logger: args.logger ?? silentLogger,
  });
  stops.push(() => app.stop());
  return { app, clock };
};

const register = async (app: BoundaApp<Registry>, customerId: string): Promise<void> => {
  await app.commands.registerCustomer?.({ customerId, email: `${customerId}@example.com` });
};

const keyRows = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT "person", "kid", "held_until", "attempts" FROM "bounda_personal_keys" ORDER BY "person"`,
    )
    .all() as { person: string; kid: string | null; held_until: string | null; attempts: number }[];

describe("a database restored while the app runs", () => {
  it("has the rotation start over at once, without the holds the copy brought back", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const before = await start({ adapter });
    await register(before.app, "c-1");
    await register(before.app, "c-2");
    await before.app.stop();

    const logger = recordingLogger();
    const { app, clock } = await start({ adapter, logger });
    const [oldKid] = keyRows(db).map(({ kid }) => kid);
    await app.rotateTenantKey();
    // A key that failed to rewrap for a while: held for long, with its attempts counted.
    db.prepare(
      `UPDATE "bounda_personal_keys" SET "held_until" = ?, "attempts" = 9 WHERE "person" = 'c-2'`,
    ).run(new Date(START.getTime() + HOLD_MAX_MS).toISOString());
    await app.runUntilIdle();
    // The backup: c-1 rewrapped, c-2 still under the old version and held.
    const copy = copyOf(db);
    db.prepare(
      `UPDATE "bounda_personal_keys" SET "held_until" = NULL WHERE "person" = 'c-2'`,
    ).run();
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    await app.runUntilIdle();
    const newKid = keyRows(db)[0]?.kid;
    expect(newKid).not.toBe(oldKid);
    expect(keyRows(db).map(({ kid }) => kid)).toEqual([newKid, newKid]);
    expect(await app.nextDueAt()).toBeNull();

    restore(db, copy);
    expect(keyRows(db)[1]).toMatchObject({ kid: oldKid, attempts: 9 });
    await app.runUntilIdle();
    expect(keyRows(db)).toEqual([
      { person: "c-1", kid: newKid, held_until: null, attempts: 0 },
      { person: "c-2", kid: newKid, held_until: null, attempts: 0 },
    ]);
    expect(logger.logged).toContainEqual({
      level: "warn",
      message: "the database went back to an earlier copy; background jobs start over",
      fields: { first: true },
    });
    expect(await app.status()).toMatchObject({ restoresFound: 1 });
  });

  it("is taken before a freeze, without a ledger to reconcile", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const logger = recordingLogger();
    const { app } = await start({ adapter, logger });
    await register(app, "c-1");
    await app.runUntilIdle();
    const copy = copyOf(db);
    await register(app, "c-2");
    await app.runUntilIdle();
    restore(db, copy);
    await app.freezeTenant("default");
    expect(await app.status()).toMatchObject({ restoresFound: 1, frozenTenant: { whole: true } });
  });

  it("moves the generation after a pass that wrote no event, as a key rewrapped, and not while idle", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const before = await start({ adapter });
    await register(before.app, "c-1");
    await before.app.stop();
    const { app, clock } = await start({ adapter });
    await app.rotateTenantKey();
    const generation = () =>
      (
        db
          .prepare(
            `SELECT "position" FROM "bounda_checkpoints" WHERE "subscriber" = 'runtime:generation'`,
          )
          .get() as { position: number } | undefined
      )?.position ?? 0;
    await app.runUntilIdle({ maxPasses: 1 });
    const rewrapped = generation();
    clock.advance(GENERATION_INTERVAL_MS);
    await app.runUntilIdle({ maxPasses: 1 });
    expect(generation()).toBe(rewrapped + 1);
    clock.advance(GENERATION_INTERVAL_MS);
    await app.runUntilIdle({ maxPasses: 1 });
    clock.advance(GENERATION_INTERVAL_MS);
    await app.runUntilIdle({ maxPasses: 1 });
    expect(generation()).toBe(rewrapped + 1);
  });

  it("forgets again at once whom the copy brings back, without waiting for the periodic reconciliation", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const ledger = memory();
    const { app, clock } = await start({
      adapter,
      runtime: { personalData: { forgetLedger: { store: ledger, reconcileEvery: "1h" } } },
    });
    await register(app, "c-1");
    await app.runUntilIdle();
    const copy = copyOf(db);
    clock.advance(GENERATION_INTERVAL_MS);
    await app.forget("c-1");
    await app.runUntilIdle();
    restore(db, copy);
    expect(db.prepare(`SELECT count(*) AS "keys" FROM "bounda_personal_keys"`).get()).toEqual({
      keys: 1,
    });
    await app.runUntilIdle();
    expect(db.prepare(`SELECT count(*) AS "keys" FROM "bounda_personal_keys"`).get()).toEqual({
      keys: 0,
    });
    const reasons = (await app.events.read({ limit: 100 }))
      .filter((event) => event.type === "PersonalDataForgotten")
      .map((event) => (event.payload as PersonalDataForgottenPayload).reason);
    expect(reasons).toEqual(["requested"]);
    // Found once, though the reconciliation of the same pass forgot someone again.
    expect((await app.status()).restoresFound).toBe(1);
  });

  it("tells every running instance, the first that found it once", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "bounda-restore-")), "store.db");
    const one = createNodeSqliteAdapter(file);
    const other = createNodeSqliteAdapter(file);
    const firstLogger = recordingLogger();
    const otherLogger = recordingLogger();
    const first = await start({ adapter: one.adapter, logger: firstLogger });
    const second = await start({ adapter: other.adapter, logger: otherLogger });
    await first.app.runUntilIdle();
    await second.app.runUntilIdle();
    const copy = copyOf(one.db);
    // What the copy undoes: activity after it, which moves the generation.
    await register(first.app, "c-1");
    first.clock.advance(GENERATION_INTERVAL_MS);
    second.clock.advance(GENERATION_INTERVAL_MS);
    await first.app.runUntilIdle();
    await second.app.runUntilIdle();
    restore(one.db, copy);
    await first.app.runUntilIdle();
    await second.app.runUntilIdle();
    const restarts = (logger: { readonly logged: Logged[] }) =>
      logger.logged.filter(
        ({ message }) =>
          message === "the database went back to an earlier copy; background jobs start over",
      );
    expect(restarts(firstLogger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect(restarts(otherLogger).map(({ fields }) => fields)).toEqual([{ first: false }]);
    expect((await second.app.status()).restoresFound).toBe(1);
  });
});

describe("a strict app's export", () => {
  const strictly = (batchSize: number): RuntimeConfig => ({
    dispatcher: { batchSize },
    personalData: { forgetLedger: { store: memory(), strict: true } },
  });

  const accesses = (logger: ReturnType<typeof recordingLogger>) =>
    logger.logged
      .filter(({ message }) => message === PERSONAL_DATA_ACCESSED)
      .map(({ fields }) => [fields?.operation, fields?.outcome, fields?.errorCode]);

  it("checks for a restore once the header is read and once for each page it reads, not for every record", async () => {
    const { adapter } = createNodeSqliteAdapter();
    let checks = 0;
    const counted = {
      ...adapter,
      createStorage: async () => {
        const opened = await adapter.createStorage();
        return {
          ...opened,
          checkpointStore: {
            ...opened.checkpointStore,
            get: (subscriber: string) => {
              if (subscriber === "runtime:generation") checks += 1;
              return opened.checkpointStore.get(subscriber);
            },
          },
        };
      },
    };
    const { app } = await start({ adapter: counted, runtime: strictly(10) });
    for (let index = 0; index < 40; index += 1) await register(app, "c-1");
    checks = 0;
    const exported = await app.exportPersonalData("c-1");
    expect(exported.events).toHaveLength(40);
    expect(checks).toBe(5);
  });

  // c-1 holds five events, a page and a half of them, in the copy and after it; c-2 is forgotten
  // after the copy, which moves the generation the watch finds the restore by.
  const copiedBefore = async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const logger = recordingLogger();
    const { app, clock } = await start({ adapter, logger, runtime: strictly(2) });
    for (let index = 0; index < 5; index += 1) await register(app, "c-1");
    await register(app, "c-2");
    await app.runUntilIdle();
    const copy = copyOf(db);
    clock.advance(GENERATION_INTERVAL_MS);
    await app.forget("c-2");
    await app.runUntilIdle();
    logger.logged.length = 0;
    return { app, db, copy, logger };
  };

  it("refuses the header it read from a copy restored under it, recorded as failed", async () => {
    const { app, db, copy, logger } = await copiedBefore();
    restore(db, copy);
    await expect(app.streamPersonalData("c-1")).rejects.toBeInstanceOf(RestoreUnreconciledError);
    expect(accesses(logger)).toEqual([["exportPersonalData", "failed", "RESTORE_UNRECONCILED"]]);
  });

  it("settles a copy restored under it before it freezes, so the export holds what the ledger says", async () => {
    const { app, db, copy, logger } = await copiedBefore();
    restore(db, copy);
    await app.freezeTenant("default");
    // Found and taken while the tenant still took writes.
    expect((await app.status()).restoresFound).toBe(1);
    expect(logger.logged.map(({ message }) => message)).toContain(
      "the database went back to an earlier copy; background jobs start over",
    );
    logger.logged.length = 0;
    const parts: TenantExportPart[] = [];
    for await (const part of await app.exportTenant("default")) parts.push(part);
    expect(parts.at(-1)?.kind).toBe("end");
    // The forgetting the copy lacked, committed again before the freeze.
    expect(
      parts.some(
        (part) =>
          part.kind === "event" &&
          part.event.type === "PersonalDataForgotten" &&
          part.event.aggregateId === "c-2",
      ),
    ).toBe(true);
    expect(accesses(logger)).toEqual([
      ["exportTenant", "started", null],
      ["exportTenant", "ok", null],
    ]);
  });

  it("refuses a page of a tenant export it read from a copy restored under it, recorded as failed", async () => {
    const { app, db, copy, logger } = await copiedBefore();
    await app.freezeTenant("default");
    logger.logged.length = 0;
    const parts = (await app.exportTenant("default"))[Symbol.asyncIterator]();
    expect((await parts.next()).value?.kind).toBe("header");
    restore(db, copy);
    await expect(parts.next()).rejects.toBeInstanceOf(RestoreUnreconciledError);
    expect(accesses(logger)).toEqual([
      ["exportTenant", "started", null],
      ["exportTenant", "failed", "RESTORE_UNRECONCILED"],
    ]);
  });

  it("refuses a page it read from a copy restored under it before handing any of it out, recorded as failed", async () => {
    const { app, db, copy, logger } = await copiedBefore();
    const parts = (await app.streamPersonalData("c-1"))[Symbol.asyncIterator]();
    const handed: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const { value } = await parts.next();
      handed.push((value as { kind: string }).kind);
    }
    restore(db, copy);
    await expect(parts.next()).rejects.toBeInstanceOf(RestoreUnreconciledError);
    expect(handed).toEqual(["header", "event", "event"]);
    expect(accesses(logger)).toEqual([
      ["exportPersonalData", "started", null],
      ["exportPersonalData", "failed", "RESTORE_UNRECONCILED"],
    ]);
  });
});

describe("a database restored while the app was stopped", () => {
  const files = () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-cold-"));
    return {
      storage: join(directory, "store.db"),
      ledger: join(directory, "ledger.db"),
    };
  };

  const restarts = (logger: { readonly logged: Logged[] }) =>
    logger.logged.filter(
      ({ message }) =>
        message === "the database went back to an earlier copy; background jobs start over",
    );

  it("is found at start from the forget ledger's mark, which clears the copy's holds and forgets again", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledger = createNodeSqliteAdapter(paths.ledger).adapter;
    const runtime: RuntimeConfig = {
      personalData: { forgetLedger: { store: ledger }, retention: "3650d" },
    };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    await before.app.runUntilIdle();
    // The copy: c-1 registered, and a person held for long after failures.
    store.db
      .prepare(
        `INSERT INTO "bounda_persons" ("person", "position", "last_active_at", "held_until", "attempts") VALUES ('c-9', 1, ?, ?, 7)`,
      )
      .run(START.toISOString(), new Date(START.getTime() + HOLD_MAX_MS).toISOString());
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    before.clock.advance(GENERATION_INTERVAL_MS);
    await before.app.runUntilIdle();
    await before.app.stop();
    restore(store.db, copy);

    const logger = recordingLogger();
    const after = await start({ adapter: store.adapter, runtime, logger });
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect(
      store.db
        .prepare(`SELECT "held_until", "attempts" FROM "bounda_persons" WHERE "person" = 'c-9'`)
        .get(),
    ).toEqual({ held_until: null, attempts: 0 });
    const reasons = (await after.app.events.read({ limit: 100 }))
      .filter((event) => event.type === "PersonalDataForgotten")
      .map((event) => (event.payload as PersonalDataForgottenPayload).reason);
    expect(reasons).toEqual(["requested"]);
    expect((await after.app.status()).restoresFound).toBe(1);
    await after.app.stop();
    const again = recordingLogger();
    await start({ adapter: store.adapter, runtime, logger: again });
    expect(restarts(again)).toEqual([]);
  });

  it("is found from a forgetting the ledger holds and the copy does not, though the mark reads stale", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
    // A store whose reads may lag its writes, as Workers KV's: the mark always reads as never raised.
    const stale = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      return {
        append: (entries) => inner.append(entries),
        read: (args) => inner.read(args),
        readMark: async () => [],
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
        clear: () => inner.clear(),
        fence: inner.fence,
      };
    });
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: stale } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    await before.app.stop();
    restore(store.db, copy);
    const logger = recordingLogger();
    // A restore takes longer than the grace a reconciliation gives a forgetting still committing.
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter: store.adapter, runtime, logger, now });
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect((await after.app.status()).restoresFound).toBe(1);
    expect((await after.app.getLag()).forgetLedger).toEqual({ reconciled: true });
  });

  it("is found once the reads of a ledger that lags show the mark, and the ledger keeps few of its values", async () => {
    const LAG = 60_000;
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
    // As Workers KV: every value raised kept with its time, a read showing those raised `LAG` ago.
    const raised = new Map<string, ForgetLedgerMark[]>();
    const pruned: string[] = [];
    let now = (): number => START.getTime();
    const lagging = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      const kept = (name: string) => {
        const values = raised.get(name) ?? [];
        raised.set(name, values);
        return values;
      };
      return {
        ...inner,
        visibilityDelayMs: LAG,
        readMark: async (name) =>
          kept(name)
            .filter(({ raisedAt }) => Date.parse(raisedAt) <= now() - LAG)
            .sort((a, b) => b.value - a.value),
        raiseMark: async (name, mark) => {
          kept(name).push(mark);
        },
        pruneMarks: async (name, before) => {
          pruned.push(name);
          const older = kept(name).filter(({ raisedAt }) => raisedAt < before);
          const highest = Math.max(...older.map(({ value }) => value));
          raised.set(
            name,
            kept(name).filter(({ value, raisedAt }) => raisedAt >= before || value === highest),
          );
        },
      };
    });
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: lagging } } };
    const before = await start({ adapter: store.adapter, runtime });
    now = () => before.clock.now().getTime();
    before.clock.advance(LAG);
    await before.app.runUntilIdle();
    const copy = copyOf(store.db);
    await register(before.app, "c-1");
    before.clock.advance(GENERATION_INTERVAL_MS);
    await before.app.runUntilIdle();
    await before.app.stop();
    restore(store.db, copy);
    const after = await start({
      adapter: store.adapter,
      runtime,
      now: new Date(before.clock.now().getTime() + 1),
    });
    now = () => after.clock.now().getTime();
    expect((await after.app.status()).restoresFound).toBe(0);
    after.clock.advance(LAG);
    await after.app.runUntilIdle();
    expect((await after.app.status()).restoresFound).toBe(1);
    expect(pruned).toContain(RESTORE_MARK);
  });

  const forgettingsOf = async (app: BoundaApp<Registry>, person: string) =>
    (await app.events.read({ limit: 100 })).filter(
      ({ type, aggregateId }) => type === "PersonalDataForgotten" && aggregateId === person,
    );

  // A ledger that takes intentions but not, while `refusing`, a committed copy, and whose mark
  // always reads as never raised: what a ledger down from a commit on leaves of it.
  const downAtCommit = (path: string) => {
    const state = { refusing: true };
    const ledgerAdapter = createNodeSqliteAdapter(path).adapter;
    const store = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      return {
        append: async (entries) => {
          if (state.refusing && entries.some(({ committed }) => committed !== false)) {
            throw new Error("the ledger is down");
          }
          await inner.append(entries);
        },
        read: (args) => inner.read(args),
        readMark: async () => [],
        raiseMark: (name, mark) => inner.raiseMark(name, mark),
        clear: () => inner.clear(),
        fence: inner.fence,
      };
    });
    return { state, store, ledgerAdapter };
  };

  it("is found from an intention written past what the copy holds, though its commit never reached the ledger", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const { store: ledger } = downAtCommit(paths.ledger);
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledger } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await register(before.app, "c-2");
    await before.app.forget("c-1");
    await before.app.stop();
    restore(store.db, copy);
    const logger = recordingLogger();
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter: store.adapter, runtime, logger, now });
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect((await after.app.status()).restoresFound).toBe(1);
    expect(await forgettingsOf(after.app, "c-1")).toHaveLength(1);
  });

  it("counts no restore of a database that holds where an intention was written, though its commit never reached the ledger", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const { store: ledger } = downAtCommit(paths.ledger);
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledger } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    await before.app.stop();
    // The copy holds the newest event the intention saw: a commit that failed leaves the same.
    restore(store.db, copy);
    const logger = recordingLogger();
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter: store.adapter, runtime, logger, now });
    expect(restarts(logger)).toEqual([]);
    expect((await after.app.status()).restoresFound).toBe(0);
    expect(await forgettingsOf(after.app, "c-1")).toHaveLength(1);
  });

  it("counts once a restore of a copy older than a restore counted before, from the intentions written since", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const { store: ledger } = downAtCommit(paths.ledger);
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledger } } };
    const first = await start({ adapter: store.adapter, runtime });
    await register(first.app, "c-1");
    const copy = copyOf(store.db);
    await first.app.stop();
    // A restore counted, then a forgetting whose intention keeps where the database stood since.
    restore(store.db, copy);
    const counted = await start({ adapter: store.adapter, runtime });
    expect(await counted.app.restored()).toEqual({ counted: true });
    // Of a person the copy does not hold, so applying it again writes nothing past the copy.
    await register(counted.app, "c-2");
    await counted.app.forget("c-2");
    await counted.app.stop();
    // The same copy again: it holds fewer restores than the intention's database had counted.
    restore(store.db, copy);
    const later = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter: store.adapter, runtime, now: later });
    await after.app.runUntilIdle();
    const found = (await after.app.status()).restoresFound;
    // Counted past the copy's own count, which knew of no restore.
    expect(found).toBe(1);
    await after.app.stop();
    // Read again, the intention tells that restore no more.
    const next = await start({
      adapter: store.adapter,
      runtime,
      now: new Date(later.getTime() + FORGET_LEDGER_GRACE_MS),
    });
    await next.app.runUntilIdle();
    expect((await next.app.status()).restoresFound).toBe(1);
    await next.app.stop();
  });

  it("appends again, by its stop, a commit the ledger did not take, ahead of the stream's copy", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const { state, store: ledger, ledgerAdapter } = downAtCommit(paths.ledger);
    const runtime: RuntimeConfig = {
      role: "web",
      personalData: { forgetLedger: { store: ledger } },
    };
    const { app } = await start({ adapter: store.adapter, runtime });
    await register(app, "c-1");
    await app.forget("c-1");
    const entries = async () => {
      const read = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      try {
        return (await read.read({ limit: 10 })).map(({ committed }) => committed);
      } finally {
        await read.close?.();
      }
    };
    expect(await entries()).toEqual([false]);
    state.refusing = false;
    await app.stop();
    expect(await entries()).toEqual([undefined]);
  });

  it("joins the restore another instance counted while it started, from a forgetting the ledger holds and the copy does not", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
    const stale = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      return { ...inner, readMark: async () => [] };
    });
    let counting = false;
    // Another instance counts the restore right after this one's start read the count.
    const adapter: typeof store.adapter = {
      ...store.adapter,
      createStorage: async (...args) => {
        const storage = await store.adapter.createStorage(...args);
        const { checkpointStore } = storage;
        return {
          ...storage,
          checkpointStore: {
            ...checkpointStore,
            get: async (name) => {
              if (counting && name === RESTORE_DECLARING) {
                counting = false;
                const found = await checkpointStore.get(RESTORES_FOUND);
                await checkpointStore.compareAndSet(RESTORES_FOUND, found, found + 1);
              }
              return checkpointStore.get(name);
            },
          },
        };
      },
    };
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: stale } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    await before.app.stop();
    restore(store.db, copy);
    counting = true;
    const logger = recordingLogger();
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter, runtime, logger, now });
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: false }]);
    expect((await after.app.status()).restoresFound).toBe(1);
  });

  it("is found once a tenant frozen at start thaws, from a forgetting the ledger holds and the copy does not", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
    const stale = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      return { ...inner, readMark: async () => [] };
    });
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: stale } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    await before.app.stop();
    restore(store.db, copy);
    const storage = await store.adapter.createStorage();
    await storage.fence.set({ state: "frozen", tenant: "default", since: START.toISOString() });
    const logger = recordingLogger();
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter: store.adapter, runtime, logger, now });
    await after.app.runUntilIdle();
    expect(restarts(logger)).toEqual([]);
    expect((await after.app.status()).restoresFound).toBe(0);
    await storage.fence.set({ state: "open" });
    after.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await after.app.runUntilIdle();
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect((await after.app.status()).restoresFound).toBe(1);
    const reasons = (await after.app.events.read({ limit: 100 }))
      .filter((event) => event.type === "PersonalDataForgotten")
      .map((event) => (event.payload as PersonalDataForgottenPayload).reason);
    expect(reasons).toEqual(["requested"]);
  });

  it("is found once a tenant frozen at start thaws, from the forget ledger's mark, and counted once", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledger = createNodeSqliteAdapter(paths.ledger).adapter;
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledger } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    await before.app.runUntilIdle();
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    before.clock.advance(GENERATION_INTERVAL_MS);
    await before.app.runUntilIdle();
    await before.app.stop();
    restore(store.db, copy);
    const storage = await store.adapter.createStorage();
    await storage.fence.set({ state: "frozen", tenant: "default", since: START.toISOString() });
    const logger = recordingLogger();
    const after = await start({ adapter: store.adapter, runtime, logger });
    await storage.fence.set({ state: "open" });
    after.clock.advance(TENANT_CHECK_INTERVAL_MS);
    await after.app.runUntilIdle();
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect((await after.app.status()).restoresFound).toBe(1);
  });

  it("finds no restore once a tenant frozen at start thaws on the database it held", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledger = createNodeSqliteAdapter(paths.ledger).adapter;
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledger } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    await before.app.forget("c-1");
    await before.app.runUntilIdle();
    await before.app.freezeTenant("default");
    await before.app.stop();
    const logger = recordingLogger();
    const after = await start({ adapter: store.adapter, runtime, logger });
    await after.app.unfreezeTenant("default");
    await after.app.runUntilIdle();
    expect(restarts(logger)).toEqual([]);
    expect((await after.app.status()).restoresFound).toBe(0);
  });

  it("leaves what a frozen start deferred for the next pass when it fails, and delivers meanwhile", async () => {
    const paths = files();
    const store = createNodeSqliteAdapter(paths.storage);
    const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
    const stale = defineForgetLedger(async () => {
      const inner = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      return { ...inner, readMark: async () => [] };
    });
    let failing = false;
    // Counting the restore fails while `failing`, before it changes anything.
    const adapter: typeof store.adapter = {
      ...store.adapter,
      createStorage: async (...args) => {
        const storage = await store.adapter.createStorage(...args);
        const { checkpointStore } = storage;
        return {
          ...storage,
          checkpointStore: {
            ...checkpointStore,
            compareAndSet: (name, expected, next) => {
              if (failing && name === RESTORES_FOUND) throw new Error("database down");
              return checkpointStore.compareAndSet(name, expected, next);
            },
          },
        };
      },
    };
    const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: stale } } };
    const before = await start({ adapter: store.adapter, runtime });
    await register(before.app, "c-1");
    const copy = copyOf(store.db);
    await before.app.forget("c-1");
    await before.app.stop();
    restore(store.db, copy);
    const storage = await store.adapter.createStorage();
    await storage.fence.set({ state: "frozen", tenant: "default", since: START.toISOString() });
    const logger = recordingLogger();
    const now = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const after = await start({ adapter, runtime, logger, now });
    await storage.fence.set({ state: "open" });
    after.clock.advance(TENANT_CHECK_INTERVAL_MS);
    failing = true;
    await register(after.app, "c-2");
    await after.app.runUntilIdle();
    const failed = () =>
      logger.logged.filter(
        ({ message }) =>
          message === "what the start left for the tenant to thaw could not be done yet",
      );
    expect(failed().length).toBeGreaterThan(0);
    expect(failed()[0]?.fields).toEqual({ errorName: "Error" });
    expect((await after.app.getLag()).maxLag).toBe(0);
    expect(restarts(logger)).toEqual([]);
    failing = false;
    await after.app.runUntilIdle();
    expect(restarts(logger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect((await after.app.status()).restoresFound).toBe(1);
    const logged = failed().length;
    await after.app.runUntilIdle();
    expect(failed()).toHaveLength(logged);
  });

  it.each([
    ["committed", 1],
    ["an intention", 0],
  ] as const)(
    "declares at a freeze the restore a forgetting the ledger holds as %s and the database lost tells",
    async (kind, found) => {
      const paths = files();
      const store = createNodeSqliteAdapter(paths.storage);
      const ledgerAdapter = createNodeSqliteAdapter(paths.ledger).adapter;
      const runtime: RuntimeConfig = { personalData: { forgetLedger: { store: ledgerAdapter } } };
      const { app } = await start({ adapter: store.adapter, runtime });
      await register(app, "c-1");
      const ledger = await ledgerAdapter.createForgetLedger({ tenant: DEFAULT_TENANT });
      await ledger.append([
        {
          personId: "c-1",
          categories: null,
          eventId: "019a6b1e-0000-7000-8000-0000000000c1",
          forgottenAt: START.toISOString(),
          reason: "requested",
          ...(kind === "committed" ? {} : { committed: false as const }),
        },
      ]);
      await ledger.close?.();
      await app.freezeTenant(DEFAULT_TENANT);
      expect((await app.status()).restoresFound).toBe(found);
      expect(
        (await app.events.read({ limit: 100 })).filter(
          (event) => event.type === "PersonalDataForgotten",
        ),
      ).toHaveLength(1);
    },
  );

  it("is declared without a ledger by bounda restored, which every running instance learns", async () => {
    const path = files().storage;
    const one = createNodeSqliteAdapter(path);
    const runningLogger = recordingLogger();
    const runtime: RuntimeConfig = { personalData: { retention: "3650d" } };
    const running = await start({
      adapter: createNodeSqliteAdapter(path).adapter,
      runtime,
      logger: runningLogger,
    });
    await running.app.runUntilIdle();
    one.db
      .prepare(
        `INSERT INTO "bounda_persons" ("person", "position", "last_active_at", "held_until", "attempts") VALUES ('c-9', 1, ?, ?, 7)`,
      )
      .run(START.toISOString(), new Date(START.getTime() + HOLD_MAX_MS).toISOString());
    const operatorLogger = recordingLogger();
    const operator = await start({ adapter: one.adapter, runtime, logger: operatorLogger });
    await operator.app.restored();
    expect(restarts(operatorLogger).map(({ fields }) => fields)).toEqual([{ first: true }]);
    expect(
      one.db
        .prepare(`SELECT "held_until", "attempts" FROM "bounda_persons" WHERE "person" = 'c-9'`)
        .get(),
    ).toEqual({ held_until: null, attempts: 0 });
    await running.app.runUntilIdle();
    expect(restarts(runningLogger).map(({ fields }) => fields)).toEqual([{ first: false }]);
    expect((await running.app.status()).restoresFound).toBe(1);
    // Declared again, it counts nothing, and starts nothing over: a hold since stays.
    one.db
      .prepare(
        `UPDATE "bounda_persons" SET "held_until" = ?, "attempts" = 3 WHERE "person" = 'c-9'`,
      )
      .run(new Date(START.getTime() + HOLD_MAX_MS).toISOString());
    expect(await operator.app.restored()).toEqual({ counted: false });
    expect(restarts(operatorLogger)).toHaveLength(1);
    expect(
      one.db.prepare(`SELECT "attempts" FROM "bounda_persons" WHERE "person" = 'c-9'`).get(),
    ).toEqual({ attempts: 3 });
    await running.app.runUntilIdle();
    expect(restarts(runningLogger)).toHaveLength(1);
  });
});

describe("an instance in the web role", () => {
  it("watches for a restore and forgets again at once whom the copy brings back", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-web-"));
    const store = createNodeSqliteAdapter(join(directory, "store.db"));
    const ledger = memory();
    const runtime: RuntimeConfig = {
      role: "web",
      personalData: { forgetLedger: { store: ledger } },
    };
    const logger = recordingLogger();
    const { app, clock } = await start({ adapter: store.adapter, runtime, logger });
    app.start();
    await register(app, "c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    const copy = copyOf(store.db);
    await app.forget("c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    restore(store.db, copy);
    expect(store.db.prepare(`SELECT count(*) AS "keys" FROM "bounda_personal_keys"`).get()).toEqual(
      {
        keys: 1,
      },
    );
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(store.db.prepare(`SELECT count(*) AS "keys" FROM "bounda_personal_keys"`).get()).toEqual(
      {
        keys: 0,
      },
    );
    expect(
      logger.logged.filter(
        ({ message }) =>
          message === "the database went back to an earlier copy; background jobs start over",
      ),
    ).toHaveLength(1);
  });

  it("waits while the tenant is frozen, and finds the restore once it thaws", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-web-"));
    const store = createNodeSqliteAdapter(join(directory, "store.db"));
    const runtime: RuntimeConfig = {
      role: "web",
      personalData: { forgetLedger: { store: memory() } },
    };
    const logger = recordingLogger();
    const { app, clock } = await start({ adapter: store.adapter, runtime, logger });
    app.start();
    await register(app, "c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    const copy = copyOf(store.db);
    await app.forget("c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    const { frozenAt } = await app.freezeTenant("default");
    // Restored by hand: the copy brings its own fence, put back as the freeze left it.
    restore(store.db, copy);
    const storage = await store.adapter.createStorage();
    await storage.fence.set({ state: "frozen", tenant: "default", since: frozenAt });
    const keys = () =>
      store.db.prepare(`SELECT count(*) AS "keys" FROM "bounda_personal_keys"`).get();
    const restarts = () =>
      logger.logged.filter(
        ({ message }) =>
          message === "the database went back to an earlier copy; background jobs start over",
      );
    const quiet = logger.logged.length;
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(keys()).toEqual({ keys: 1 });
    // Nothing tried while frozen, the restore included.
    expect(logger.logged.slice(quiet)).toEqual([]);
    await app.unfreezeTenant("default");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(keys()).toEqual({ keys: 0 });
    expect(restarts()).toHaveLength(1);
  });

  it("logs a watch that failed, as on a freeze it could not read, and goes on watching", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-web-"));
    const store = createNodeSqliteAdapter(join(directory, "store.db"));
    let failing = false;
    const adapter: typeof store.adapter = {
      ...store.adapter,
      createStorage: async (...args) => {
        const storage = await store.adapter.createStorage(...args);
        return {
          ...storage,
          fence: {
            ...storage.fence,
            read: () =>
              failing ? Promise.reject(new Error("fence unreadable")) : storage.fence.read(),
          },
        };
      },
    };
    const logger = recordingLogger();
    const runtime: RuntimeConfig = {
      role: "web",
      personalData: { forgetLedger: { store: memory() } },
    };
    const { app, clock } = await start({ adapter, runtime, logger });
    app.start();
    await register(app, "c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    const copy = copyOf(store.db);
    await app.forget("c-1");
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    failing = true;
    const failed = () =>
      logger.logged.filter(
        ({ message }) => message === "the watch for a restore failed; it looks again later",
      );
    while (failed().length === 0) await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(failed()[0]).toEqual({
      level: "error",
      message: "the watch for a restore failed; it looks again later",
      fields: { errorName: "Error" },
    });
    restore(store.db, copy);
    failing = false;
    for (let tick = 0; tick < 3; tick += 1)
      await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(
      logger.logged.filter(
        ({ message }) =>
          message === "the database went back to an earlier copy; background jobs start over",
      ),
    ).toHaveLength(1);
  });

  it("arms no look once stopped, though one was under way", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const { app, clock } = await start({ adapter, runtime: { role: "web" } });
    app.start();
    const waiting = clock.pending();
    clock.advance(GENERATION_INTERVAL_MS);
    await app.stop();
    await new Promise((resolve) => setImmediate(resolve));
    expect(clock.pending()).toBeLessThan(waiting);
  });
});

describe("a copy restored by hand under a frozen tenant", () => {
  const raised = (logger: { readonly logged: Logged[] }) =>
    logger.logged.filter(
      ({ message }) =>
        message ===
        "the tenant is frozen and a database's fence was open, as a copy restored by hand leaves it: raised again",
    );

  it("has its fence raised again by the next pass, which the next commit then meets", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const logger = recordingLogger();
    const { app } = await start({ adapter, logger });
    await register(app, "c-1");
    await app.runUntilIdle();
    const copy = copyOf(db);
    const { frozenAt } = await app.freezeTenant("default");
    restore(db, copy);
    expect(db.prepare(`SELECT count(*) AS "rows" FROM "bounda_tenant_fence"`).get()).toEqual({
      rows: 0,
    });
    await app.runUntilIdle();
    expect(raised(logger).map(({ fields }) => fields)).toEqual([
      { tenant: "default", frozenAt, databases: 1 },
    ]);
    await expect(register(app, "c-2")).rejects.toMatchObject({ code: "TENANT_FROZEN", frozenAt });
  });

  it("has its fence raised again by an instance that runs no worker, at its next look", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-web-"));
    const store = createNodeSqliteAdapter(join(directory, "store.db"));
    const logger = recordingLogger();
    const { app, clock } = await start({
      adapter: store.adapter,
      runtime: { role: "web" },
      logger,
    });
    app.start();
    await register(app, "c-1");
    const copy = copyOf(store.db);
    const { frozenAt } = await app.freezeTenant("default");
    restore(store.db, copy);
    await advanceUntilWaiting(clock, GENERATION_INTERVAL_MS);
    expect(raised(logger)).toHaveLength(1);
    await expect(register(app, "c-2")).rejects.toMatchObject({ code: "TENANT_FROZEN", frozenAt });
  });

  it("has its fence raised again by a start on it, which then starts frozen", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const before = await start({ adapter });
    await register(before.app, "c-1");
    await before.app.runUntilIdle();
    const copy = copyOf(db);
    const { frozenAt } = await before.app.freezeTenant("default");
    await before.app.stop();
    restore(db, copy);
    const logger = recordingLogger();
    const after = await start({ adapter, logger });
    expect(raised(logger)).toHaveLength(1);
    expect((await after.app.status()).frozenTenant).toMatchObject({ frozenAt });
    await expect(register(after.app, "c-2")).rejects.toMatchObject({ code: "TENANT_FROZEN" });
  });
});
