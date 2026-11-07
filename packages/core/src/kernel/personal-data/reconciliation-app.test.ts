import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
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
import { FORGET_LEDGER_SUBSCRIBER } from "./ledger-outbox.ts";
import {
  FORGET_LEDGER_CURSOR,
  FORGET_LEDGER_REREAD_MS,
  FORGET_LEDGER_RETRY_MS,
  FORGET_LEDGER_START_TIMEOUT_MS,
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
  readonly now?: Date;
  readonly logger?: Logger;
}

let starts = 0;

const start = async ({ storage, forgetLedger, now = START, logger = silentLogger }: StartArgs) => {
  starts += 1;
  const clock = createFixedClock(now);
  const app = await createApp({
    registry,
    config: { storage, runtime: { personalData: { forgetLedger } } },
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
});

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
      events.map((event) => entry(event.aggregateId, event.id, new Date(event.timestamp))),
    );
    expect(events.map((event) => event.aggregateId)).toEqual(["c-0", "c-1"]);
  });

  it("forgets again at start, with reason restored, a person the ledger names whose forgetting the store does not hold", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: before, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await register("c-2");
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", START)]);
    await before.stop();
    const { logs, logger } = recording();
    const { app, forgotten, customer } = await start({
      storage,
      forgetLedger: ledgerAdapter,
      logger,
    });
    expect(await forgotten()).toEqual([["c-1", "restored"]]);
    expect(await customer("c-1")).toBeNull();
    expect(await customer("c-2")).toEqual({ customerId: "c-2", name: "name of c-2" });
    expect(logs).toContainEqual([
      "info",
      "personal data forgotten",
      expect.objectContaining({ personId: "c-1", reason: "restored", hadKey: true }),
    ]);
    const exported = await app.exportPersonalData("c-1");
    expect(exported.events.map(({ type, data }) => [type, data])).toEqual([
      ["CustomerRegistered", { name: null }],
      ["PersonalDataForgotten", {}],
    ]);
    expect((await app.exportPersonalData("c-2")).events[0]?.data).toEqual({ name: "name of c-2" });
    expect(logs).toContainEqual([
      "warn",
      "forgot again persons a restored backup brought back",
      { forgotten: 1 },
    ]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    await app.runUntilIdle();
    const restored = (await app.events.read({ limit: 100 })).at(-1);
    expect(await (await opened(ledgerAdapter)).read({ limit: 10 })).toContainEqual({
      personId: "c-1",
      eventId: restored?.id,
      forgottenAt: restored?.timestamp,
    });
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
      "forgot again persons a restored backup brought back",
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
    const { forgotten } = await start({ storage, forgetLedger: ledgerAdapter });
    expect(await forgotten()).toEqual([["c-2", "restored"]]);
    expect(await written.checkpointStore.get(FORGET_LEDGER_CURSOR)).toBe(cursor);
  });

  it("forgets a person once when two apps start on the same store together", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", START)]);
    await first.stop();
    const [one] = await Promise.all([
      start({ storage, forgetLedger: ledgerAdapter }),
      start({ storage, forgetLedger: ledgerAdapter }),
    ]);
    expect(await one.forgotten()).toEqual([["c-1", "restored"]]);
  });

  it("starts when the ledger cannot be read, says so, and reconciles in the worker after a while", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", START)]);
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
      expect.objectContaining({ message: "ledger is down" }),
    ]);
    expect(await app.nextDueAt()).toEqual(new Date(START.getTime() + FORGET_LEDGER_RETRY_MS));
    expect(await app.runUntilIdle()).toMatchObject({ idle: true });
    expect(clock.now()).toEqual(START);
    clock.advance(FORGET_LEDGER_RETRY_MS);
    await app.runUntilIdle();
    expect(await forgotten()).toEqual([]);
    expect(await app.nextDueAt()).toEqual(new Date(START.getTime() + 3 * FORGET_LEDGER_RETRY_MS));
    clock.advance(2 * FORGET_LEDGER_RETRY_MS);
    expect(await app.runUntilIdle({ maxPasses: 1 })).toMatchObject({ idle: false });
    expect(await forgotten()).toEqual([["c-1", "restored"]]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
    expect(await app.nextDueAt()).toBeNull();
  });

  it("starts once the ledger has not answered in time, and reconciles when it does", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const { app: first, register } = await start({ storage, forgetLedger: ledgerAdapter });
    await register("c-1");
    await first.stop();
    await (await opened(ledgerAdapter)).append([entry("c-1", "lost-forget", START)]);
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
      config: { storage, runtime: { personalData: { forgetLedger: slow } } },
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
      clock.advance(FORGET_LEDGER_START_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const app = await starting;
    stops.push(() => app.stop());
    expect(logs).toContainEqual([
      "error",
      "forget ledger did not answer in time; the app starts and reconciles in the background",
      { timeoutMs: FORGET_LEDGER_START_TIMEOUT_MS },
    ]);
    expect(await app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
    answer();
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
    expect(await forgotten()).toEqual([["c-1", "restored"]]);
    expect(await app.nextDueAt()).toBeNull();
  });

  it("copies a forgetting again once the ledger takes it", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    let refusals = 1;
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
    const { app, clock } = await start({ storage, forgetLedger: refusing });
    await app.forget("c-1");
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
          runtime: { personalData: { forgetLedger: closing } },
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
      ["c-1", "restored"],
      ["c-2", "restored"],
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
