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
});
