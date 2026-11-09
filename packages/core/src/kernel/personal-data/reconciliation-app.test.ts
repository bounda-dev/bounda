import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { DEFAULT_FORGET_LEDGER_TIMEOUT_MS } from "../../config/defaults.ts";
import type { ForgetLedgerConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import {
  ForgetLedgerUnavailableError,
  ForgetLedgerUnreconciledError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type {
  PersonalDataForgottenEvent,
  PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";
import { createApp } from "../app.ts";
import { defineForgetLedger, type ForgetLedgerSource } from "./forget-ledger.ts";
import { HOLD_MS } from "./hold.ts";
import { FORGET_LEDGER_SUBSCRIBER } from "./ledger-outbox.ts";
import {
  FORGET_LEDGER_ATTEMPTS,
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_GRACE_MS,
  FORGET_LEDGER_HELD_UNTIL,
  FORGET_LEDGER_REREAD_MS,
} from "./reconciliation.ts";

const START = new Date("2026-03-01T00:00:00.000Z");

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), name: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({ customerId: f.string().primaryKey(), name: f.string() }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { name: string | null }>;
              table: Table<CustomerRow>;
            }) => {
              await table.upsert({ customerId: event.aggregateId, name: event.payload.name ?? "" });
            },
          },
        },
        bounda: {
          personalDataForgotten: {
            project: async ({
              event,
              table,
            }: {
              event: PersonalDataForgottenEvent;
              table: Table<CustomerRow>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {
        getCustomer: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<CustomerRow>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: CustomerRow | null }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

interface CustomerRow {
  readonly customerId: string;
  readonly name: string;
}

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

const recording = () => {
  const logs: [string, string, unknown][] = [];
  const logger: Logger = {
    ...silentLogger,
    info: (message, fields) => logs.push(["info", message, fields]),
    warn: (message, fields) => logs.push(["warn", message, fields]),
    error: (message, fields) => logs.push(["error", message, fields]),
  };
  return { logs, logger };
};

interface StartArgs {
  readonly storage: Adapter;
  readonly forgetLedger: ForgetLedgerSource;
  readonly options?: Omit<ForgetLedgerConfig, "store">;
  readonly now?: Date;
  readonly logger?: Logger;
}

let starts = 0;

const start = async ({
  storage,
  forgetLedger,
  options = {},
  now = START,
  logger = silentLogger,
}: StartArgs) => {
  starts += 1;
  const clock = createFixedClock(now);
  const app = await createApp({
    registry,
    config: {
      storage,
      runtime: { personalData: { forgetLedger: { store: forgetLedger, ...options } } },
    },
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock,
    logger,
  });
  stops.push(() => app.stop());
  const register = async (customerId: string): Promise<void> => {
    const commands = app.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId, name: `name of ${customerId}` });
    await app.runUntilIdle();
  };
  const customer = (customerId: string): Promise<unknown> =>
    (app.queries as unknown as Record<string, (args: unknown) => Promise<unknown>>).getCustomer?.({
      customerId,
    }) ?? Promise.resolve(undefined);
  const forgotten = async (): Promise<readonly (readonly [string, string])[]> =>
    (await app.events.read({ limit: 1000 }))
      .filter((event) => event.type === "PersonalDataForgotten")
      .map((event) => {
        const { personId, reason } = event.payload as PersonalDataForgottenPayload;
        return [personId, reason] as const;
      });
  return { app, clock, register, forgotten, customer };
};

const entry = (personId: string, eventId: string, at: Date): ForgetLedgerEntry => ({
  personId,
  eventId,
  forgottenAt: at.toISOString(),
  reason: "requested",
});

// A forgetting the store lost, old enough at `START` for a reconciliation to commit it again.
const LOST = new Date(START.getTime() - FORGET_LEDGER_GRACE_MS - 60_000);

const opened = async (ledgerAdapter: Adapter): Promise<ForgetLedger> =>
  ledgerAdapter.createForgetLedger({});

describe("the forget ledger", () => {
  it("receives every forgetting the store holds, those from before it was configured included", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const first = await createApp({
      registry,
      config: { storage },
      clock: createFixedClock(new Date(START.getTime() - 60_000)),
    });
    await first.forget("c-0");
    await first.stop();
    const { app } = await start({ storage, forgetLedger: ledgerAdapter });
    await app.forget("c-1");
    await app.runUntilIdle();
    const events = (await app.events.read({ limit: 100 })).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toEqual(
      events.map((event) => ({
        ...entry(event.aggregateId, event.id, new Date(event.timestamp)),
        fingerprints: [],
      })),
    );
    expect(events.map((event) => event.aggregateId)).toEqual(["c-0", "c-1"]);
  });

  it("commits again at start, under its own id, time and reason, a forgetting the ledger names that the store does not hold", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: before, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await register("c-2");
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    await before.stop();
    const { logs, logger } = recording();
    const { app, forgotten, customer } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      logger,
    });
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(await customer("c-1")).toBeNull();
    expect(await customer("c-2")).toEqual({ customerId: "c-2", name: "name of c-2" });
    expect(logs).toContainEqual([
      "info",
      "personal data forgotten",
      expect.objectContaining({ personId: "c-1", reason: "requested", hadKey: true }),
    ]);
    const exported = await app.exportPersonalData("c-1");
    expect(exported.events.map(({ type, data }) => [type, data])).toEqual([
      ["CustomerRegistered", { name: null }],
      ["PersonalDataForgotten", {}],
    ]);
    expect((await app.exportPersonalData("c-2")).events[0]?.data).toEqual({ name: "name of c-2" });
    expect(logs).toContainEqual([
      "warn",
      "committed again forgettings the database did not hold",
      { forgotten: 1 },
    ]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    await app.runUntilIdle();
    const restored = (await app.events.read({ limit: 100 })).at(-1);
    expect(restored).toMatchObject({
      id: "lost-forget",
      timestamp: LOST.toISOString(),
      payload: { reason: "requested", fingerprints: [expect.any(String)] },
    });
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toEqual([
      entry("c-1", "lost-forget", LOST),
    ]);
  });

  it("forgets nobody on a normal start, nor a person given a key again after the forgetting the store holds", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.forget("c-1");
    await register("c-1");
    await first.runUntilIdle();
    await (
      first.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).registerCustomer?.({ customerId: "c-2", name: "name of c-2" });
    await first.stop();
    const { logs, logger } = recording();
    const { app, forgotten, customer } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      logger,
    });
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    // A start that forgot nobody leaves the read models to the background.
    expect(await customer("c-2")).toBeNull();
    expect(logs.map(([, message]) => message)).not.toContain(
      "committed again forgettings the database did not hold",
    );
    expect((await app.exportPersonalData("c-1")).events.at(-1)?.data).toEqual({
      name: "name of c-1",
    });
  });

  it("only moves the cursor past a person who holds no key", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const later = new Date(START.getTime() + 60_000);
    await (await opened(ledgerAdapter)).append([entry("c-9", "lost-forget", later)]);
    const { app, forgotten } = await start({ storage, forgetLedger: ledgerAdapter });
    expect(await forgotten()).toEqual([]);
    const written = await storage.createStorage();
    expect(await written.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(later.getTime());
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
  });

  it("reads the ledger from a while before its cursor, never from further back", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await register("c-2");
    await first.stop();
    const cursor = START.getTime() + 2 * FORGET_LEDGER_REREAD_MS;
    const written = await storage.createStorage();
    await written.checkpointStore.set(FORGET_LEDGER_CURSOR, cursor);
    await (await opened(ledgerAdapter)).append([
      entry("c-1", "too-old", new Date(cursor - FORGET_LEDGER_REREAD_MS - 1)),
      entry("c-2", "in-window", new Date(cursor - FORGET_LEDGER_REREAD_MS + 1)),
    ]);
    const { forgotten } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      now: new Date(cursor),
    });
    expect(await forgotten()).toEqual([["c-2", "requested"]]);
    expect(await written.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(cursor);
  });

  it("forgets a person once when two apps start on the same store together", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    await first.stop();
    const [one] = await Promise.all([
      start({ storage, forgetLedger: ledgerAdapter }),
      start({ storage, forgetLedger: ledgerAdapter }),
    ]);
    expect(await one.forgotten()).toEqual([["c-1", "requested"]]);
  });

  it("starts when the ledger cannot be read, says so, and reconciles in the worker after a while", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    let failures = 2;
    const flaky = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error("ledger is down");
          }
          return inner.read(args);
        },
      };
    });
    const { logs, logger } = recording();
    const { app, clock, forgotten } = await start({ storage, forgetLedger: flaky, logger });
    expect(await forgotten()).toEqual([]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
    expect(logs).toContainEqual([
      "error",
      "forget ledger could not be reconciled; persons a restored backup brought back are not forgotten yet",
      expect.objectContaining({ errorName: "Error" }),
    ]);
    expect(await app.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    expect(await app.runUntilIdle()).toMatchObject({ idle: true });
    expect(clock.now()).toEqual(START);
    clock.advance(HOLD_MS);
    await app.runUntilIdle();
    expect(await forgotten()).toEqual([]);
    expect(await app.nextDueAt()).toEqual(new Date(START.getTime() + 3 * HOLD_MS));
    clock.advance(2 * HOLD_MS);
    expect(await app.runUntilIdle({ maxPasses: 1 })).toMatchObject({ idle: false });
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    expect(await app.nextDueAt()).toBeNull();
  });

  it("holds the reconciliation beside the cursor, so another instance waits for it, until one succeeds", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    let down = true;
    let reads = 0;
    const flaky = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          reads += 1;
          if (down) throw new Error("ledger is down");
          return inner.read(args);
        },
      };
    });
    const written = await storage.createStorage();
    const stored = async () => [
      await written.checkpointStore.get(FORGET_LEDGER_HELD_UNTIL),
      await written.checkpointStore.get(FORGET_LEDGER_ATTEMPTS),
    ];
    const one = await start({ storage, forgetLedger: flaky });
    expect(await stored()).toEqual([START.getTime() + HOLD_MS, 1]);
    // Failing in the same round, the other instance waits for that hold instead of adding to it.
    const later = new Date(START.getTime() + 10_000);
    const other = await start({ storage, forgetLedger: flaky, now: later });
    expect(await stored()).toEqual([START.getTime() + HOLD_MS, 1]);
    expect(await other.app.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    one.clock.advance(HOLD_MS);
    await one.app.runUntilIdle();
    const heldUntil = START.getTime() + 3 * HOLD_MS;
    expect(await stored()).toEqual([heldUntil, 2]);
    other.clock.set(new Date(START.getTime() + HOLD_MS));
    const readsBefore = reads;
    await other.app.runUntilIdle();
    expect(reads).toBe(readsBefore);
    expect(await stored()).toEqual([heldUntil, 2]);
    expect(await other.app.nextDueAt()).toEqual(new Date(heldUntil));
    down = false;
    one.clock.set(new Date(heldUntil));
    expect(await one.app.runUntilIdle({ maxPasses: 1 })).toMatchObject({ idle: false });
    expect(await one.forgotten()).toEqual([["c-1", "requested"]]);
    expect(await stored()).toEqual([0, 0]);
    expect(await one.app.nextDueAt()).toBeNull();
    other.clock.set(new Date(heldUntil));
    await other.app.runUntilIdle();
    expect(await other.app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    expect(await other.forgotten()).toEqual([["c-1", "requested"]]);
  });

  it("reconciles at every start, and backs off from the failures before a restart", async () => {
    const storage = memory();
    const broken = defineForgetLedger(async () => ({
      append: async () => undefined,
      read: async () => {
        throw new Error("ledger is down");
      },
    }));
    const { app: first } = await start({ storage, forgetLedger: broken });
    // A fresh store's first pass finds nothing written before the marks.
    await first.runUntilIdle();
    expect(await first.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    await first.stop();
    const restartedAt = new Date(START.getTime() + HOLD_MS + 1_000);
    const { app } = await start({ storage, forgetLedger: broken, now: restartedAt });
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
    expect(await app.nextDueAt()).toEqual(new Date(restartedAt.getTime() + 2 * HOLD_MS));
    await app.stop();
    const { app: early } = await start({ storage, forgetLedger: broken, now: restartedAt });
    expect(await early.nextDueAt()).toEqual(new Date(restartedAt.getTime() + 2 * HOLD_MS));
  });

  it("starts once the ledger has not answered in time, and reconciles when it does", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const slow = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          await answered;
          return inner.read(args);
        },
      };
    });
    const { logs, logger } = recording();
    const clock = createFixedClock(START);
    const starting = createApp({
      registry,
      config: { storage, runtime: { personalData: { forgetLedger: { store: slow } } } },
      ids: createSequentialIdGenerator({ prefix: "slow" }),
      clock,
      logger,
    });
    let started: Awaited<typeof starting> | undefined;
    void starting.then((app) => {
      started = app;
    });
    // The start arms its timer once it reaches the ledger, which the test cannot see.
    while (started === undefined) {
      clock.advance(DEFAULT_FORGET_LEDGER_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const app = await starting;
    stops.push(() => app.stop());
    // Each call to the ledger is given up at the timeout, so the reconciliation fails then, and
    // tries again once its hold ends.
    expect(logs).toContainEqual([
      "error",
      "forget ledger could not be reconciled; persons a restored backup brought back are not forgotten yet",
      expect.objectContaining({
        errorName: "ForgetLedgerTimeoutError",
        errorCode: "FORGET_LEDGER_TIMEOUT",
      }),
    ]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
    answer();
    clock.advance(HOLD_MS);
    await app.runUntilIdle();
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
  });

  it("starts after the timeout when the reconciliation takes longer, each call to the ledger within it", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    for (const person of ["c-1", "c-2", "c-3"]) await register(person);
    await first.stop();
    await (await opened(ledgerAdapter)).append(
      ["c-1", "c-2", "c-3"].map((person) => entry(person, `lost-${person}`, LOST)),
    );
    const clock = createFixedClock(START);
    let reconciling = false;
    // Each forgetting the reconciliation commits again takes most of the timeout.
    const slow: Adapter = {
      ...storage,
      createStorage: async () => {
        const opened = await storage.createStorage();
        return {
          ...opened,
          transact: async (work) => {
            if (reconciling) {
              clock.advance(DEFAULT_FORGET_LEDGER_TIMEOUT_MS / 2);
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
            return opened.transact(work);
          },
        };
      },
    };
    const watching = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: (args) => {
          reconciling = true;
          return inner.read(args);
        },
      };
    });
    const { logs, logger } = recording();
    const app = await createApp({
      registry,
      config: { storage: slow, runtime: { personalData: { forgetLedger: { store: watching } } } },
      clock,
      logger,
    });
    stops.push(() => app.stop());
    expect(logs).toContainEqual([
      "error",
      "forget ledger did not answer in time; the app starts and reconciles in the background",
      { timeoutMs: DEFAULT_FORGET_LEDGER_TIMEOUT_MS },
    ]);
    await vi.waitFor(async () =>
      expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } }),
    );
  });

  it("reads a ledger whose entries show late once more after its delay", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    const late = defineForgetLedger(async () => ({
      ...(await opened(ledgerAdapter)),
      visibilityDelayMs: 60_000,
    }));
    const { app, clock, forgotten } = await start({ storage, forgetLedger: late });
    expect(await app.nextDueAt()).toEqual(new Date(START.getTime() + 60_000));
    await (await opened(ledgerAdapter)).append([entry("c-1", "shown-late", START)]);
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(await app.nextDueAt()).toBeNull();
  });

  it("copies a forgetting from the stream once the ledger takes it, when it refused its intention", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    let refusals = 2;
    const refusing = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: async (entries) => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error("ledger is down");
          }
          await inner.append(entries);
        },
      };
    });
    const { logs, logger } = recording();
    const { app, clock } = await start({ storage, forgetLedger: refusing, logger });
    await app.forget("c-1");
    expect(refusals).toBe(1);
    expect(logs).toContainEqual([
      "warn",
      "forget ledger did not take the forgetting; it commits, and the stream copies it",
      expect.objectContaining({ errorName: "Error" }),
    ]);
    await app.runUntilIdle({ maxPasses: 1 });
    expect(refusals).toBe(0);
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toEqual([]);
    const lag = await app.getLag();
    expect(
      lag.subscribers.find(({ subscriber }) => subscriber === FORGET_LEDGER_SUBSCRIBER),
    ).toMatchObject({ lag: 1 });
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(
      (await (await opened(ledgerAdapter)).read({ limit: 10 })).map(({ personId }) => personId),
    ).toEqual(["c-1"]);
  });

  it("records a forgetting in the ledger before it commits, and the stream copies it once", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await app.forget("c-1");
    const [forgetting] = (await app.events.read({ limit: 100 })).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    const appended = [
      { ...entry("c-1", forgetting?.id ?? "", START), fingerprints: [expect.any(String)] },
    ];
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toEqual(appended);
    await app.runUntilIdle();
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toEqual(appended);
  });

  it("appends the forgettings of forgetAgain as they commit", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app, register, forgotten } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await app.forgetAgain([{ personId: "c-1" }]);
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(
      (await (await opened(ledgerAdapter)).read({ limit: 10 })).map(({ personId }) => personId),
    ).toEqual(["c-1"]);
  });

  it("records what the retention forgets before it commits, and the stream copies it", async () => {
    const ledgerAdapter = memory();
    const appends: string[] = [];
    const watching = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: async (entries) => {
          appends.push(...entries.map(({ personId }) => personId));
          await inner.append(entries);
        },
      };
    });
    const clock = createFixedClock(START);
    const app = await createApp({
      registry,
      config: {
        storage: memory(),
        runtime: { personalData: { retention: "1h", forgetLedger: { store: watching } } },
      },
      clock,
    });
    stops.push(() => app.stop());
    const commands = app.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "c-1", name: "Ada" });
    await app.runUntilIdle();
    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(
      (await app.events.read({ limit: 100 })).filter(
        (event) => event.type === "PersonalDataForgotten",
      ),
    ).toHaveLength(1);
    // Once as the forgetting's intention, once more from the stream.
    expect(appends).toEqual(["c-1", "c-1"]);
  });

  it("commits a forgetting once the ledger has not taken its intention in time, says so, and waits for it no more while it hangs", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const hanging = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: () => new Promise<void>(() => undefined),
      };
    });
    const { logs, logger } = recording();
    const { app, clock } = await start({ storage, forgetLedger: hanging, logger });
    let done = false;
    const forgetting = app.forget("c-1").then(() => {
      done = true;
    });
    // The append arms its timer once it is called, which the test cannot see.
    while (!done) {
      clock.advance(DEFAULT_FORGET_LEDGER_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await forgetting;
    expect(logs).toContainEqual([
      "warn",
      "forget ledger did not take the forgetting; it commits, and the stream copies it",
      expect.objectContaining({
        errorName: "ForgetLedgerTimeoutError",
        errorCode: "FORGET_LEDGER_TIMEOUT",
      }),
    ]);
    await app.forget("c-2");
    const forgotten = (await app.events.read({ limit: 100 })).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    expect(forgotten.map((event) => event.aggregateId)).toEqual(["c-1", "c-2"]);
  });

  it("reconciles again every reconcileEvery while the app runs, one instance a period", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    let reads = 0;
    const counting = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          reads += 1;
          return inner.read(args);
        },
      };
    });
    const options = { reconcileEvery: "1m" } as const;
    const one = await start({ storage, forgetLedger: counting, options });
    const other = await start({ storage, forgetLedger: counting, options });
    await one.register("c-1");
    expect(reads).toBe(2);
    // As if the database had been restored, while the app runs, to before c-1 was forgotten.
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    expect(await one.app.nextDueAt()).toBeNull();
    one.clock.advance(59_999);
    other.clock.advance(59_999);
    await one.app.runUntilIdle();
    expect(reads).toBe(2);
    one.clock.advance(1);
    other.clock.advance(1);
    await one.app.runUntilIdle();
    await other.app.runUntilIdle();
    expect(reads).toBe(3);
    expect(await one.forgotten()).toEqual([["c-1", "requested"]]);
    expect(await one.customer("c-1")).toBeNull();
    other.clock.advance(60_000);
    await other.app.runUntilIdle();
    await one.app.runUntilIdle();
    expect(reads).toBe(4);
  });

  it("waits for another instance's failure before its periodic reconciliation", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    let failures = 0;
    let reads = 0;
    const flaky = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          reads += 1;
          if (failures > 0) {
            failures -= 1;
            throw new Error("ledger is down");
          }
          return inner.read(args);
        },
      };
    });
    const options = { reconcileEvery: "1m" } as const;
    const one = await start({ storage, forgetLedger: flaky, options });
    failures = 1;
    const later = new Date(START.getTime() + 60_000 - HOLD_MS / 2);
    const other = await start({ storage, forgetLedger: flaky, options, now: later });
    expect(reads).toBe(2);
    one.clock.advance(60_000);
    await one.app.runUntilIdle();
    expect(reads).toBe(2);
    one.clock.advance(HOLD_MS / 2);
    await one.app.runUntilIdle();
    expect(reads).toBe(3);
    expect(await other.app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
  });

  it("prunes the entries older than keepFor with the periodic reconciliation", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    await (await opened(ledgerAdapter)).append([
      entry("c-old", "old", new Date(START.getTime() - 3_600_000)),
      entry("c-new", "new", new Date(START.getTime() - 3_600_000 + 60_000)),
    ]);
    const { app, clock } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      options: { reconcileEvery: "1m", keepFor: "1h" },
    });
    expect((await (await opened(ledgerAdapter)).read({ limit: 10 })).length).toBe(2);
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(
      (await (await opened(ledgerAdapter)).read({ limit: 10 })).map(({ eventId }) => eventId),
    ).toEqual(["new"]);
    const created: (number | undefined)[] = [];
    const pruneless = defineForgetLedger(async ({ keepForMs }) => {
      created.push(keepForMs);
      const { prune: _, ...inner } = await opened(ledgerAdapter);
      return inner;
    });
    const { logs, logger } = recording();
    const { app: kept, clock: keptClock } = await start({
      storage: memory(),
      forgetLedger: pruneless,
      options: { reconcileEvery: "1m", keepFor: "1h" },
      logger,
    });
    expect(created).toEqual([3_600_000]);
    keptClock.advance(60_000);
    expect(await kept.runUntilIdle()).toMatchObject({ idle: true });
    expect(logs.filter(([level]) => level === "error")).toEqual([]);
  });

  it("logs a prune that fails and goes on", async () => {
    const ledgerAdapter = memory();
    const failing = defineForgetLedger(async () => ({
      ...(await opened(ledgerAdapter)),
      prune: async () => {
        throw new Error("ledger is read-only");
      },
    }));
    const { logs, logger } = recording();
    const { app, clock } = await start({
      storage: memory(),
      forgetLedger: failing,
      options: { reconcileEvery: "1m", keepFor: "1h" },
      logger,
    });
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(logs).toContainEqual([
      "error",
      "forget ledger could not be pruned",
      expect.objectContaining({ errorName: "Error" }),
    ]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
  });

  it("does not start, when strict, until it has read the ledger, and fails when it cannot", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", LOST)]);
    const down = new Error("ledger is down");
    let closed = 0;
    const broken = defineForgetLedger(async () => ({
      append: async () => {},
      read: async () => {
        throw down;
      },
      close: async () => {
        closed += 1;
      },
    }));
    const failing = start({ storage, forgetLedger: broken, options: { strict: true } });
    await expect(failing).rejects.toThrow(ForgetLedgerUnreconciledError);
    await expect(failing).rejects.toMatchObject({
      code: "FORGET_LEDGER_UNRECONCILED",
      cause: down,
    });
    expect(closed).toBe(1);
    let answer: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const slow = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        append: (entries) => inner.append(entries),
        read: async (args) => {
          await answered;
          return inner.read(args);
        },
      };
    });
    const clock = createFixedClock(START);
    let settled = false;
    const starting = createApp({
      registry,
      config: {
        storage,
        runtime: {
          personalData: { forgetLedger: { store: slow, strict: true, timeout: "1m" } },
        },
      },
      clock,
    }).finally(() => {
      settled = true;
    });
    void starting.catch(() => undefined);
    // Waits past the default timeout, then gives the read up at its own.
    for (let round = 0; round < 5; round += 1) {
      clock.advance(DEFAULT_FORGET_LEDGER_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(settled).toBe(false);
    while (!settled) {
      clock.advance(DEFAULT_FORGET_LEDGER_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(starting).rejects.toMatchObject({
      code: "FORGET_LEDGER_UNRECONCILED",
      cause: { code: "FORGET_LEDGER_TIMEOUT", operation: "read", timeoutMs: 60_000 },
    });
    answer();
    const app = await createApp({
      registry,
      config: {
        storage,
        runtime: { personalData: { forgetLedger: { store: slow, strict: true } } },
      },
      clock,
    });
    stops.push(() => app.stop());
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    const events = await app.events.read({ limit: 100 });
    expect(events.filter((event) => event.type === "PersonalDataForgotten")).toHaveLength(1);
  });

  it("closes the ledger when the app stops", async () => {
    let closed = 0;
    const ledgerAdapter = memory();
    const closing = defineForgetLedger(async () => ({
      ...(await opened(ledgerAdapter)),
      close: async () => {
        closed += 1;
      },
    }));
    const { app } = await start({ storage: memory(), forgetLedger: closing });
    await app.stop();
    expect(closed).toBe(1);
  });

  it("closes the ledger when the start fails after opening it", async () => {
    let closed = 0;
    const ledgerAdapter = memory();
    const closing = defineForgetLedger(async () => ({
      ...(await opened(ledgerAdapter)),
      close: async () => {
        closed += 1;
      },
    }));
    const broken: Adapter = {
      ...memory(),
      createReadModel: async () => {
        throw new Error("read model database is down");
      },
    };
    await expect(
      createApp({
        registry,
        config: {
          storage: memory(),
          readModels: { customers: broken },
          runtime: { personalData: { forgetLedger: { store: closing } } },
        },
      }),
    ).rejects.toThrow("read model database is down");
    expect(closed).toBe(1);
  });

  it("names no ledger in the lag of an app without one", async () => {
    const { app } = await createTestApp({ registry });
    stops.push(() => app.stop());
    expect(await app.getLag()).toMatchObject({ forgetLedger: null });
  });
});

// The memory adapter whose storage transactions fail while `failing` says so, as a process that
// stops between the intention and the commit leaves the store.
const crashing = (storage: Adapter) => {
  const state = { failing: false };
  const adapter: Adapter = {
    ...storage,
    createStorage: async () => {
      const opened = await storage.createStorage();
      return {
        ...opened,
        transact: async (work) => {
          if (state.failing) throw new Error("the process stopped");
          return opened.transact(work);
        },
      };
    },
  };
  return { adapter, state };
};

describe("the intention a forgetting records first", () => {
  it("is committed by the next start when the process stops before the commit, under its id, time and reason", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { adapter, state } = crashing(storage);
    const { app, register } = await start({ storage: adapter, forgetLedger: ledgerAdapter });
    await register("c-1");
    state.failing = true;
    await expect(app.forget("c-1")).rejects.toThrow("the process stopped");
    const [intention] = await (await opened(ledgerAdapter)).read({ limit: 10 });
    expect(intention).toEqual({
      personId: "c-1",
      eventId: expect.any(String),
      forgottenAt: START.toISOString(),
      reason: "requested",
      fingerprints: [expect.any(String)],
    });
    expect(await app.exportPersonalData("c-1")).toMatchObject({
      events: [{ data: { name: "name of c-1" } }],
    });
    await app.stop();
    state.failing = false;
    const later = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const { app: next, customer } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      now: later,
    });
    const forgetting = (await next.events.read({ limit: 100 })).at(-1);
    expect(forgetting).toMatchObject({
      id: intention?.eventId,
      timestamp: START.toISOString(),
      payload: { personId: "c-1", reason: "requested", fingerprints: intention?.fingerprints },
    });
    expect(await customer("c-1")).toBeNull();
  });

  it("waits for its grace before a reconciliation commits it, and is due once that ends", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { adapter, state } = crashing(storage);
    const { app, register } = await start({ storage: adapter, forgetLedger: ledgerAdapter });
    await register("c-1");
    state.failing = true;
    await expect(app.forget("c-1")).rejects.toThrow("the process stopped");
    await app.stop();
    state.failing = false;
    const {
      app: next,
      clock,
      forgotten,
    } = await start({
      storage,
      forgetLedger: ledgerAdapter,
    });
    expect(await forgotten()).toEqual([]);
    expect(await next.nextDueAt()).toEqual(new Date(START.getTime() + FORGET_LEDGER_GRACE_MS));
    clock.advance(FORGET_LEDGER_GRACE_MS);
    await next.runUntilIdle();
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(await next.nextDueAt()).toBeNull();
  });

  it("leaves a key given to the person after it, when its commit never happened", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { adapter, state } = crashing(storage);
    const { app } = await start({ storage: adapter, forgetLedger: ledgerAdapter });
    state.failing = true;
    await expect(app.forget("c-1")).rejects.toThrow("the process stopped");
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toMatchObject([
      { personId: "c-1", fingerprints: [] },
    ]);
    state.failing = false;
    await app.stop();
    const later = new Date(START.getTime() + FORGET_LEDGER_GRACE_MS);
    const { register } = await start({ storage, forgetLedger: ledgerAdapter, now: later });
    await register("c-1");
    const { forgotten, customer } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      now: later,
    });
    expect(await forgotten()).toEqual([]);
    expect(await customer("c-1")).toEqual({ customerId: "c-1", name: "name of c-1" });
  });

  it("forgets nobody, when strict, while the ledger does not take it, so calling again is safe", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    let down = true;
    const flaky = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: async (entries) => {
          if (down) throw new Error("ledger is down");
          await inner.append(entries);
        },
      };
    });
    const { app, register, forgotten, customer } = await start({
      storage,
      forgetLedger: flaky,
      options: { strict: true },
    });
    await register("c-1");
    const refused = app.forget("c-1");
    await expect(refused).rejects.toBeInstanceOf(ForgetLedgerUnavailableError);
    await expect(refused).rejects.toMatchObject({
      code: "FORGET_LEDGER_UNAVAILABLE",
      cause: new Error("ledger is down"),
    });
    expect(await forgotten()).toEqual([]);
    expect(await customer("c-1")).toEqual({ customerId: "c-1", name: "name of c-1" });
    expect(await app.forgetAgain([{ personId: "c-1" }]).catch((error: unknown) => error)).toEqual(
      expect.any(ForgetLedgerUnavailableError),
    );
    expect(await forgotten()).toEqual([]);
    down = false;
    await app.forget("c-1");
    expect(await forgotten()).toEqual([["c-1", "requested"]]);
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toHaveLength(1);
  });

  it("forgets nobody, when strict, once the ledger has not taken it within its timeout", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const hanging = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: () => new Promise<void>(() => undefined),
      };
    });
    const { app, clock, register, forgotten } = await start({
      storage,
      forgetLedger: hanging,
      options: { strict: true, timeout: "2s" },
    });
    await register("c-1");
    let outcome: unknown;
    const forgetting = app.forget("c-1").then(
      () => "forgotten",
      (error: unknown) => error,
    );
    void forgetting.then((settled) => {
      outcome = settled;
    });
    while (outcome === undefined) {
      clock.advance(1_000);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(outcome).toBeInstanceOf(ForgetLedgerUnavailableError);
    expect(outcome).toMatchObject({
      cause: { code: "FORGET_LEDGER_TIMEOUT", operation: "append", timeoutMs: 2_000 },
    });
    expect(await forgotten()).toEqual([]);
  });

  it("keeps a person past the retention, when strict, while the ledger does not take it", async () => {
    let down = true;
    const ledgerAdapter = memory();
    const flaky = defineForgetLedger(async () => {
      const inner = await opened(ledgerAdapter);
      return {
        read: (args) => inner.read(args),
        append: async (entries) => {
          if (down) throw new Error("ledger is down");
          await inner.append(entries);
        },
      };
    });
    const clock = createFixedClock(START);
    const { logs, logger } = recording();
    const app = await createApp({
      registry,
      config: {
        storage: memory(),
        runtime: {
          personalData: { retention: "1h", forgetLedger: { store: flaky, strict: true } },
        },
      },
      clock,
      logger,
    });
    stops.push(() => app.stop());
    const commands = app.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "c-1", name: "Ada" });
    await app.runUntilIdle();
    clock.advance(3_600_000);
    await app.runUntilIdle();
    const forgettings = async () =>
      (await app.events.read({ limit: 100 })).filter(
        (event) => event.type === "PersonalDataForgotten",
      );
    expect(await forgettings()).toEqual([]);
    expect(logs).toContainEqual([
      "error",
      "person past the retention could not be forgotten",
      expect.objectContaining({ personId: "c-1", errorCode: "FORGET_LEDGER_UNAVAILABLE" }),
    ]);
    down = false;
    clock.advance(HOLD_MS);
    await app.runUntilIdle();
    expect((await forgettings()).map((event) => event.payload)).toMatchObject([
      { personId: "c-1", reason: "retention" },
    ]);
  });

  it("commits again a forgetting the retention made only while the retention would still forget the person", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const config = (retention: "1h" | "2h") => ({
      storage,
      runtime: { personalData: { retention, forgetLedger: { store: ledgerAdapter } } },
    });
    const clock = createFixedClock(START);
    const first = await createApp({ registry, config: config("1h"), clock });
    const commands = first.commands as unknown as Record<
      string,
      (payload: { customerId: string; name: string }) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "c-1", name: "Ada" });
    await commands.registerCustomer?.({ customerId: "c-2", name: "Bob" });
    await first.runUntilIdle();
    await first.stop();
    const retained = (person: string): ForgetLedgerEntry => ({
      ...entry(person, `retained-${person}`, LOST),
      reason: "retention",
    });
    await (await opened(ledgerAdapter)).append([retained("c-1"), retained("c-2")]);
    clock.advance(90 * 60_000);
    const later = await createApp({ registry, config: config("2h"), clock });
    stops.push(() => later.stop());
    expect(
      (await later.events.read({ limit: 100 })).filter(
        (event) => event.type === "PersonalDataForgotten",
      ),
    ).toEqual([]);
    await later.stop();
    const due = await createApp({ registry, config: config("1h"), clock });
    stops.push(() => due.stop());
    expect(
      (await due.events.read({ limit: 100 }))
        .filter((event) => event.type === "PersonalDataForgotten")
        .map((event) => [event.id, (event.payload as PersonalDataForgottenPayload).reason]),
    ).toEqual([
      ["retained-c-1", "retention"],
      ["retained-c-2", "retention"],
    ]);
  });
});

describe("forgetAgain", () => {
  it("forgets again whom an entry names unless the store holds its forgetting or they hold no key", async () => {
    const storage = memory();
    const { logs, logger } = recording();
    const { app, register, forgotten } = await start({
      storage,
      forgetLedger: memory(),
      logger,
    });
    await register("c-1");
    await register("c-2");
    await register("c-3");
    const [held] = (await app.events.read({ limit: 100 })).filter(
      (event) => event.aggregateId === "c-3",
    );
    await app.forget("c-4");
    const forgetting = (await app.events.read({ limit: 100 })).at(-1);
    expect(
      await app.forgetAgain([
        { personId: "c-1" },
        { personId: "c-2", eventId: "not-held" },
        { personId: "c-4", eventId: forgetting?.id as string },
        { personId: "c-5" },
        { personId: "c-1" },
      ]),
    ).toEqual(["c-1", "c-2"]);
    expect(held).toBeDefined();
    expect(logs.filter(([, message]) => message === "personal data forgotten")).toHaveLength(3);
    expect(await forgotten()).toEqual([
      ["c-4", "requested"],
      ["c-1", "requested"],
      ["c-2", "requested"],
    ]);
  });

  it("names who forgets them again, in the event's metadata and the log, and refuses an actor as would", async () => {
    const { logs, logger } = recording();
    const { app, register } = await start({ storage: memory(), forgetLedger: memory(), logger });
    await register("c-1");
    await expect(app.forgetAgain([{ personId: "c-1" }], { actor: "" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await app.forgetAgain([{ personId: "c-1" }], { actor: "operator-1" })).toEqual(["c-1"]);
    const forgetting = (await app.events.read({ limit: 100 })).at(-1);
    expect(forgetting).toMatchObject({
      type: "PersonalDataForgotten",
      metadata: { actor: "operator-1" },
    });
    expect(logs).toContainEqual([
      "info",
      "personal data forgotten",
      expect.objectContaining({ personId: "c-1", reason: "requested", actor: "operator-1" }),
    ]);
  });

  it("rejects an entry without a person's id before forgetting anyone", async () => {
    const { app, register, forgotten } = await start({ storage: memory(), forgetLedger: memory() });
    await register("c-1");
    const refused = app.forgetAgain([{ personId: "c-1" }, { personId: "" }]);
    await expect(refused).rejects.toBeInstanceOf(ValidationError);
    await expect(refused).rejects.toThrow("forgetAgain needs the id of the person");
    expect(await forgotten()).toEqual([]);
  });
});
