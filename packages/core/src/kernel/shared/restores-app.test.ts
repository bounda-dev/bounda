import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type LogFields, type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataForgottenPayload } from "../../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { HOLD_MAX_MS } from "../personal-data/hold.ts";
import { masterKey } from "../personal-data/master-key.ts";
import { ROTATION_CHECK_INTERVAL_MS } from "../personal-data/rotation.ts";
import { advanceUntilWaiting } from "../test-support.ts";
import { GENERATION_INTERVAL_MS } from "./restores.ts";

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
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), email: z.email() }),
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

const randomKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

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

const start = async (args: {
  readonly adapter: ReturnType<typeof createNodeSqliteAdapter>["adapter"];
  readonly runtime?: RuntimeConfig;
  readonly env?: Record<string, string>;
  readonly logger?: Logger;
}): Promise<{ app: BoundaApp<Registry>; clock: ReturnType<typeof createFixedClock> }> => {
  started += 1;
  const clock = createFixedClock(START);
  const app = await createApp<Registry>({
    registry,
    config: {
      storage: args.adapter,
      ...(args.runtime === undefined ? {} : { runtime: args.runtime }),
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
    const old = randomKey();
    const before = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: old },
      runtime: { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } },
    });
    await register(before.app, "c-1");
    await register(before.app, "c-2");
    await before.app.stop();

    const logger = recordingLogger();
    const { app, clock } = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: randomKey(), BOUNDA_MASTER_KEY_PREVIOUS: old },
      runtime: {
        personalData: {
          keyWrapper: masterKey({
            from: "BOUNDA_MASTER_KEY",
            previous: ["BOUNDA_MASTER_KEY_PREVIOUS"],
          }),
        },
      },
      logger,
    });
    // A key that failed to rewrap for a while: held for long, with its attempts counted.
    db.prepare(
      `UPDATE "bounda_personal_keys" SET "held_until" = ?, "attempts" = 9 WHERE "person" = 'c-2'`,
    ).run(new Date(START.getTime() + HOLD_MAX_MS).toISOString());
    await app.runUntilIdle();
    const [, oldKid] = keyRows(db).map(({ kid }) => kid);
    // The backup: c-1 rewrapped, c-2 still under the old key and held.
    const copy = copyOf(db);
    db.prepare(
      `UPDATE "bounda_personal_keys" SET "held_until" = NULL WHERE "person" = 'c-2'`,
    ).run();
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    await app.runUntilIdle();
    const newKid = keyRows(db)[0]?.kid;
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

  it("moves the generation after a pass that wrote no event, as a key rewrapped, and not while idle", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const old = randomKey();
    const before = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: old },
      runtime: { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } },
    });
    await register(before.app, "c-1");
    await before.app.stop();
    const { app, clock } = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: randomKey(), BOUNDA_MASTER_KEY_PREVIOUS: old },
      runtime: {
        personalData: {
          keyWrapper: masterKey({
            from: "BOUNDA_MASTER_KEY",
            previous: ["BOUNDA_MASTER_KEY_PREVIOUS"],
          }),
        },
      },
    });
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
    expect(reasons).toEqual(["restored"]);
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
    expect(reasons).toEqual(["restored"]);
    expect((await after.app.status()).restoresFound).toBe(1);
    await after.app.stop();
    const again = recordingLogger();
    await start({ adapter: store.adapter, runtime, logger: again });
    expect(restarts(again)).toEqual([]);
  });

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
});
