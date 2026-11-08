import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { fingerprintOf, fromBase64 } from "./crypto.ts";
import { defineKeyWrapper } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), name: z.string() }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.email(), name: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const plainRegistry = {
  aggregates: {
    note: {
      state: { initialState: {} },
      events: {
        noteTaken: {
          payload: ({ z }: EventPayloadArgs) => z.object({ text: z.string() }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

const randomKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

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

const wrapped = (previous?: readonly string[]): RuntimeConfig => ({
  personalData: {
    keyWrapper: masterKey({
      from: "BOUNDA_MASTER_KEY",
      ...(previous === undefined ? {} : { previous }),
    }),
  },
});

interface StartArgs {
  readonly adapter: Adapter;
  readonly env?: Record<string, string>;
  readonly runtime?: RuntimeConfig;
  readonly logger?: Logger;
}

const start = ({ adapter, env = {}, runtime, logger }: StartArgs): Promise<BoundaApp<Registry>> =>
  createApp<Registry>({
    registry,
    config: { storage: adapter, ...(runtime === undefined ? {} : { runtime }) },
    env,
    clock: createFixedClock(),
    ...(logger === undefined ? {} : { logger }),
  });

const register = (app: BoundaApp<Registry>, customerId: string) => {
  const command = app.commands.registerCustomer;
  if (command === undefined) throw new Error("registerCustomer is not in the registry");
  return command({ customerId, email: `${customerId}@example.com`, name: "Ada" });
};

const emailOf = async (app: BoundaApp<Registry>, customerId: string) =>
  (await app.exportPersonalData(customerId)).events[0]?.data;

const keyRows = (db: ReturnType<typeof createNodeSqliteAdapter>["db"]) =>
  db.prepare(`SELECT "person", "key", "fingerprint", "kid" FROM "bounda_personal_keys"`).all() as {
    person: string;
    key: string;
    fingerprint: string;
    kid: string | null;
  }[];

describe("personal keys wrapped under a master key", () => {
  it("keeps no raw key in the key table: a dump of it opens nothing without the master key", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const app = await start({ adapter, env, runtime: wrapped() });
    await register(app, "c-1");
    await register(app, "c-2");
    const wrapper = await masterKey({ from: "BOUNDA_MASTER_KEY" }).create({ env });
    const rows = keyRows(db);
    expect(rows.map(({ person, kid }) => [person, kid])).toEqual([
      ["c-1", wrapper.kid],
      ["c-2", wrapper.kid],
    ]);
    for (const row of rows) {
      expect(await fingerprintOf(fromBase64(row.key))).not.toBe(row.fingerprint);
      const raw = await wrapper.unwrap({ kid: wrapper.kid, wrapped: fromBase64(row.key) });
      expect(await fingerprintOf(Uint8Array.from(raw))).toBe(row.fingerprint);
    }
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    await app.stop();
  });

  it("forgets a person at once on every instance, even one that holds their key unwrapped", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const reader = await start({ adapter, env, runtime: wrapped() });
    const other = await start({ adapter, env, runtime: wrapped() });
    await register(reader, "c-1");
    expect(await emailOf(reader, "c-1")).toEqual({ email: "c-1@example.com" });
    await other.forget("c-1");
    expect(await emailOf(reader, "c-1")).toEqual({ email: null });
    await reader.stop();
    await other.stop();
  });

  it("lets go of the key it holds unwrapped for a person it forgets again", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    let unwraps = 0;
    const counting = defineKeyWrapper(async (args) => {
      const wrapper = await masterKey({ from: "BOUNDA_MASTER_KEY" }).create(args);
      return {
        ...wrapper,
        unwrap: (wrapped) => {
          unwraps += 1;
          return wrapper.unwrap(wrapped);
        },
      };
    });
    const app = await start({ adapter, env, runtime: { personalData: { keyWrapper: counting } } });
    await register(app, "c-1");
    const [row] = keyRows(db);
    expect(await app.forgetAgain([{ personId: "c-1" }])).toEqual(["c-1"]);
    // The same row put back, as a restore would: unwrapped again, so the app had let it go.
    db.prepare(
      `INSERT INTO "bounda_personal_keys" ("person", "key", "fingerprint", "kid") VALUES (?, ?, ?, ?)`,
    ).run(row?.person ?? "", row?.key ?? "", row?.fingerprint ?? "", row?.kid ?? null);
    const before = unwraps;
    await emailOf(app, "c-1");
    expect(unwraps).toBe(before + 1);
    await app.stop();
  });

  it("rewraps every key in the background once the master key moves to previous, and the data still opens", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const old = randomKey();
    const first = await start({ adapter, env: { BOUNDA_MASTER_KEY: old }, runtime: wrapped() });
    await register(first, "c-1");
    await register(first, "c-2");
    await first.stop();

    const env = { BOUNDA_MASTER_KEY: randomKey(), BOUNDA_MASTER_KEY_PREVIOUS: old };
    const logger = recordingLogger();
    const rotated = await start({
      adapter,
      env,
      runtime: wrapped(["BOUNDA_MASTER_KEY_PREVIOUS"]),
      logger,
    });
    const current = await masterKey({
      from: "BOUNDA_MASTER_KEY",
      previous: ["BOUNDA_MASTER_KEY_PREVIOUS"],
    }).create({ env });
    expect(current.previous).toHaveLength(1);
    expect(await rotated.nextDueAt()).not.toBeNull();
    expect(await rotated.runUntilIdle()).toEqual({ idle: true, rejections: [] });
    expect(keyRows(db).map(({ kid }) => kid)).toEqual([current.kid, current.kid]);
    expect(logger.logged).toContainEqual({
      level: "info",
      message: "no personal key is wrapped under a previous key any more; remove them",
      fields: { kid: current.kid, previous: current.previous ?? [] },
    });
    expect(await rotated.nextDueAt()).toBeNull();
    await rotated.stop();

    const without = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: env.BOUNDA_MASTER_KEY },
      runtime: wrapped(),
    });
    expect(await emailOf(without, "c-1")).toEqual({ email: "c-1@example.com" });
    expect(await emailOf(without, "c-2")).toEqual({ email: "c-2@example.com" });
    await without.stop();
  });

  it("wraps the keys an app kept in the clear once a master key is set", async () => {
    const { adapter, db } = createNodeSqliteAdapter();
    const before = await start({ adapter });
    await register(before, "c-1");
    await before.stop();
    expect(keyRows(db).map(({ kid }) => kid)).toEqual([null]);
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const after = await start({ adapter, env, runtime: wrapped() });
    expect(await emailOf(after, "c-1")).toEqual({ email: "c-1@example.com" });
    await after.runUntilIdle();
    const { kid } = await masterKey({ from: "BOUNDA_MASTER_KEY" }).create({ env });
    expect(keyRows(db).map((row) => row.kid)).toEqual([kid]);
    expect(await emailOf(after, "c-1")).toEqual({ email: "c-1@example.com" });
    await after.stop();
  });

  it("fails clearly under a wrong master key, and without one", async () => {
    const { adapter } = createNodeSqliteAdapter();
    const env = { BOUNDA_MASTER_KEY: randomKey() };
    const right = await start({ adapter, env, runtime: wrapped() });
    await register(right, "c-1");
    const { kid } = await masterKey({ from: "BOUNDA_MASTER_KEY" }).create({ env });
    await right.stop();

    const wrong = await start({
      adapter,
      env: { BOUNDA_MASTER_KEY: randomKey() },
      runtime: wrapped(),
    });
    await expect(wrong.exportPersonalData("c-1")).rejects.toThrow(
      new ConfigurationError(
        `A personal key is wrapped under ${kid}, which is neither the key wrapper's key nor one of its previous ones`,
      ),
    );
    await wrong.stop();

    const none = await start({ adapter });
    await expect(none.exportPersonalData("c-1")).rejects.toThrow(
      new ConfigurationError(
        `A personal key is wrapped under ${kid}, and runtime.personalData.keyWrapper is not set`,
      ),
    );
    await none.stop();
  });

  it("fails the start when the master key's variable is missing", async () => {
    await expect(start({ adapter: memory(), runtime: wrapped() })).rejects.toThrow(
      /The environment variable BOUNDA_MASTER_KEY, which runtime\.personalData\.keyWrapper names as a master key, is not set/,
    );
  });

  it("runs in a test app given the master key in its env, and drops its unwrapped keys when it stops", async () => {
    const { app, clock } = await createTestApp({
      registry,
      config: { runtime: wrapped() },
      env: { BOUNDA_MASTER_KEY: randomKey() },
    });
    await register(app, "c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    await app.forget("c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: null });
    await register(app, "c-2");
    expect(clock.pending()).toBeGreaterThan(0);
    await app.stop();
    expect(clock.pending()).toBe(0);
  });
});

describe("personal keys without a key wrapper", () => {
  const warning = {
    level: "warn",
    message:
      "personal keys are stored unwrapped, next to the data they open: set runtime.personalData.keyWrapper",
    fields: undefined,
  };

  it("warns once at start when the registry marks personal fields, and works as before", async () => {
    const logger = recordingLogger();
    const app = await start({ adapter: memory(), logger });
    expect(logger.logged.filter(({ level }) => level === "warn")).toEqual([warning]);
    await register(app, "c-1");
    expect(await emailOf(app, "c-1")).toEqual({ email: "c-1@example.com" });
    await app.stop();
  });

  it("warns nothing with a wrapper, without personal fields, or in a test app", async () => {
    const quiet = async (app: Promise<{ stop(): Promise<void> }>, logger: { logged: Logged[] }) => {
      await (await app).stop();
      expect(logger.logged.filter(({ level }) => level === "warn")).toEqual([]);
    };
    const withWrapper = recordingLogger();
    await quiet(
      start({
        adapter: memory(),
        env: { BOUNDA_MASTER_KEY: randomKey() },
        runtime: wrapped(),
        logger: withWrapper,
      }),
      withWrapper,
    );
    const plain = recordingLogger();
    await quiet(
      createApp({ registry: plainRegistry, config: { storage: memory() }, logger: plain }),
      plain,
    );
    const test = recordingLogger();
    await quiet(
      createTestApp({ registry, logger: test }).then(({ app }) => app),
      test,
    );
  });
});
