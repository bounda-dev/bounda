import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { RuntimeConfig } from "../../config/types.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { expectForgotten } from "../../testing/expect-forgotten.ts";
import { createApp } from "../app.ts";
import {
  BACKFILL_EXPIRY_MS,
  BACKFILL_FOLLOW_INTERVAL_MS,
  BACKFILL_LEASE_MS,
  BACKFILL_PREFIX,
} from "./backfill.ts";
import { HOLD_MS } from "./hold.ts";
import { defineKeyWrapper } from "./key-wrapper.ts";

const START = new Date("2026-05-01T00:00:00.000Z");
const MINUTE_MS = 60_000;

interface Marks {
  // Which fields of the registry are marked: none before the marks, the email and address after,
  // and the name too for marks that change once more.
  readonly email: boolean;
  readonly name?: boolean;
}

// Toggled by a test: the policy, and the reminder when it runs, fail and quote the email.
const failing = { greet: false, remind: false };

const registryOf = ({ email, name = false }: Marks): Registry =>
  ({
    aggregates: {
      customer: {
        state: { initialState: {} },
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                email: email ? personal(z.email()) : z.email(),
                name: name ? personal(z.string()) : z.string(),
              }),
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
              }) => [
                events.customerRegistered?.({
                  email: command.payload.email,
                  name: command.payload.name,
                }),
              ],
            },
          },
          remindCustomer: {
            module: {
              payload: ({ z, personal }: CommandPayloadArgs) =>
                z.object({
                  customerId: z.string(),
                  email: email ? personal(z.email()) : z.email(),
                }),
              handler: ({ command }: { command: { payload: { email: string } } }) => {
                if (failing.remind) {
                  throw new ValidationError(`cannot remind ${command.payload.email}`, []);
                }
                return [];
              },
            },
          },
        },
        policies: {
          greetOnRegistered: {
            module: {
              on: "CustomerRegistered",
              handler: async ({ event }: { event: { payload: { email: string | null } } }) => {
                if (failing.greet) {
                  throw new ValidationError(`cannot greet ${event.payload.email}`, []);
                }
              },
            },
          },
        },
        processes: {},
      },
      order: {
        state: { initialState: {} },
        events: {
          orderPlaced: {
            payload: ({ z, person, personal }: EventPayloadArgs) =>
              z.object({
                customerId: email ? person(z.string()) : z.string(),
                address: email ? personal(z.string()) : z.string(),
              }),
            evolve: () => ({}),
          },
        },
        commands: {
          placeOrder: {
            module: {
              payload: ({ z }: PayloadArgs) =>
                z.object({ orderId: z.string(), customerId: z.string(), address: z.string() }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { customerId: string; address: string } };
                events: Record<string, (payload?: unknown) => unknown>;
              }) => [
                events.orderPlaced?.({
                  customerId: command.payload.customerId,
                  address: command.payload.address,
                }),
              ],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  }) as unknown as Registry;

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  failing.greet = false;
  failing.remind = false;
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
  readonly adapter: Adapter;
  readonly marks: Marks;
  readonly now?: Date;
  readonly logger?: Logger;
  readonly runtime?: RuntimeConfig;
}

let starts = 0;

const start = async ({
  adapter,
  marks,
  now = START,
  logger = silentLogger,
  runtime = {},
}: StartArgs) => {
  starts += 1;
  const clock = createFixedClock(now);
  const app = await createApp({
    registry: registryOf(marks),
    config: { storage: adapter, runtime },
    ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
    clock,
    logger,
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  stops.push(stop);
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: { readonly delay?: string }) => Promise<unknown>
  >;
  return { app, clock, commands, stop };
};

const unmarked: Marks = { email: false };
const marked: Marks = { email: true };

const raw = async (adapter: Adapter): Promise<readonly StoredEvent[]> =>
  (await adapter.createStorage()).eventStore.readAll({ afterPosition: 0, limit: 100 });

const registered = (events: readonly StoredEvent[]) =>
  events.filter((event) => event.type === "CustomerRegistered");

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

describe.each(adapters)("the backfill of personal data on %s", (_name, adapterOf) => {
  it("seals in place what events, scheduled commands and dead letters hold of fields marked after they were written", async () => {
    const adapter = adapterOf();
    const before = await start({ adapter, marks: unmarked });
    failing.greet = true;
    failing.remind = true;
    await before.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await before.commands.placeOrder?.({ orderId: "o-1", customerId: "c-2", address: "Bilbao" });
    await before.commands.remindCustomer?.(
      { customerId: "c-1", email: "ada@example.com" },
      { delay: "1m" },
    );
    await before.commands.remindCustomer?.(
      { customerId: "c-1", email: "ada@example.com" },
      { delay: "1d" },
    );
    before.clock.advance(MINUTE_MS);
    await before.app.runUntilIdle();
    await before.stop();
    failing.greet = false;
    failing.remind = false;
    const storage = await adapter.createStorage();
    expect(await storage.deadLetterStore.count()).toBe(2);
    expect(await storage.personalKeys.get("c-1")).toBeNull();

    const { logger, logs } = recording();
    const after = await start({
      adapter,
      marks: marked,
      now: new Date(before.clock.now().getTime() + MINUTE_MS),
      logger,
    });
    expect(await after.app.getLag()).toMatchObject({
      personalDataBackfill: { position: 0, caughtUp: false },
    });
    await after.app.runUntilIdle();

    const key = await storage.personalKeys.get("c-1");
    // Without a retention, nobody's activity is recorded.
    expect(await storage.persons.get("c-1")).toBeNull();
    const events = await raw(adapter);
    const [customer] = registered(events);
    expect(customer?.person).toBe("c-1");
    expect(customer?.payload).toMatchObject({
      email: { $personal: { person: "c-1", key: key?.fingerprint } },
      name: "Ada",
    });
    const order = events.find((event) => event.type === "OrderPlaced");
    expect(order?.person).toBe("c-2");
    expect(order?.payload).toMatchObject({
      customerId: "c-2",
      address: { $personal: { person: "c-2" } },
    });
    const [scheduled] = await storage.scheduler.list();
    expect(scheduled?.persons).toEqual([{ person: "c-1", fingerprint: key?.fingerprint }]);
    expect(scheduled?.command.payload).toMatchObject({ email: { $personal: { person: "c-1" } } });
    const letters = await storage.deadLetterStore.list();
    expect(letters.map((letter) => [letter.kind, letter.person]).sort()).toEqual([
      ["policy", "c-1"],
      ["scheduled", "c-1"],
    ]);
    expect(JSON.stringify(letters)).not.toContain("ada@example.com");
    expect(JSON.stringify(events)).not.toContain("ada@example.com");
    expect(await after.app.getLag()).toMatchObject({
      personalDataBackfill: { position: events.at(-1)?.position, caughtUp: true },
    });
    expect(logs).toContainEqual([
      "info",
      "personal data written before its marks is sealed",
      expect.objectContaining({ events: 2, scheduledCommands: 1, deadLetters: 2 }),
    ]);

    const exported = await after.app.exportPersonalData("c-1");
    expect(exported.events.map((event) => event.data)).toEqual([{ email: "ada@example.com" }]);
    expect(exported.scheduledCommands.map((command) => command.data)).toEqual([
      { email: "ada@example.com" },
    ]);
    expect(exported.deadLetters.map((letter) => letter.errorMessage).sort()).toEqual([
      "cannot greet ada@example.com",
      "cannot remind ada@example.com",
    ]);

    await after.app.forget("c-1");
    expect(await storage.scheduler.list()).toEqual([]);
    expect((await storage.deadLetterStore.list()).map((letter) => letter.kind)).toEqual(["policy"]);
    expect((await after.app.deadLetters.list()).map((letter) => letter.errorMessage)).toEqual([
      null,
    ]);
    expect(
      (await after.app.exportPersonalData("c-1")).events.map((event) => event.data),
    ).toContainEqual({ email: null });
    await expectForgotten(adapter, "c-1", { values: ["ada@example.com"] });
  });

  it("seals under a key nobody holds what a person forgotten before the marks had, and gives them no key", async () => {
    const adapter = adapterOf();
    const before = await start({ adapter, marks: unmarked });
    await before.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await before.app.forget("c-1");
    await before.commands.registerCustomer?.({
      customerId: "c-2",
      email: "grace@example.com",
      name: "Grace",
    });
    await before.app.forget("c-2");
    await before.commands.registerCustomer?.({
      customerId: "c-2",
      email: "grace@again.example",
      name: "Grace",
    });
    await before.app.runUntilIdle();
    await before.stop();

    const { logger, logs } = recording();
    const after = await start({ adapter, marks: marked, logger });
    await after.app.runUntilIdle();

    const storage = await adapter.createStorage();
    expect(await storage.personalKeys.get("c-1")).toBeNull();
    const key = await storage.personalKeys.get("c-2");
    const sealedUnder = registered(await raw(adapter)).map(
      (event) => (event.payload as { email: { $personal: { key: string } } }).email.$personal.key,
    );
    expect(sealedUnder[2]).toBe(key?.fingerprint);
    expect(new Set(sealedUnder).size).toBe(3);
    const emails = async (person: string) =>
      (await after.app.exportPersonalData(person)).events
        .filter((event) => event.type === "CustomerRegistered")
        .map((event) => event.data);
    expect(await emails("c-1")).toEqual([{ email: null }]);
    expect(await emails("c-2")).toEqual([{ email: null }, { email: "grace@again.example" }]);
    expect(logs).toContainEqual([
      "warn",
      "personal data of persons forgotten before it was marked is sealed for good; rebuild the read models that project it",
      expect.objectContaining({ events: 2, eventTypes: ["customer.CustomerRegistered"] }),
    ]);
  });
});

describe("the backfill of personal data", () => {
  it("walks once per set of marks: a start with the same marks reseals nothing, other marks walk again", async () => {
    const adapter = memory();
    const before = await start({ adapter, marks: unmarked });
    await before.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await before.stop();
    const first = await start({ adapter, marks: marked });
    await first.app.runUntilIdle();
    await first.stop();
    const [sealed] = registered(await raw(adapter));

    const again = await start({ adapter, marks: marked });
    expect(await again.app.nextDueAt()).toBeNull();
    expect(await again.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: true } });
    await again.app.runUntilIdle();
    expect(registered(await raw(adapter))).toEqual([sealed]);
    await again.stop();

    const storage = await adapter.createStorage();
    const rows = async () =>
      (await storage.checkpointStore.list())
        .map(({ subscriber }) => subscriber)
        .filter((subscriber) => subscriber.startsWith(BACKFILL_PREFIX));
    const before2 = await rows();
    const other = await start({ adapter, marks: { email: true, name: true } });
    expect(await other.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: false } });
    await other.app.runUntilIdle();
    const [resealed] = registered(await raw(adapter));
    expect(resealed?.payload).toMatchObject({
      email: (sealed?.payload as { email: unknown } | undefined)?.email,
      name: { $personal: { person: "c-1" } },
    });
    // The rows of the first marks stay while an instance may still run them.
    expect(await rows()).toEqual(expect.arrayContaining(before2));
    other.clock.advance(BACKFILL_EXPIRY_MS + BACKFILL_LEASE_MS);
    await other.app.runUntilIdle();
    expect((await rows()).some((row) => before2.includes(row))).toBe(false);
  });

  it("follows the stream, sealing a follow interval later what older marks still write, and the stores again", async () => {
    const adapter = memory();
    const app = await start({ adapter, marks: marked });
    await app.app.runUntilIdle();
    const storage = await adapter.createStorage();
    // What an instance still running without the marks writes, as in a rolling deploy.
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "c-1",
      expectedVersion: 0,
      events: [
        {
          id: "late",
          aggregateType: "customer",
          aggregateId: "c-1",
          version: 1,
          type: "CustomerRegistered",
          payload: { email: "ada@example.com", name: "Ada" },
          timestamp: START.toISOString(),
          metadata: {
            correlationId: "c",
            causationId: "c",
            commandId: "c",
            depth: 0,
            schemaVersion: 1,
            system: false,
          },
          person: null,
        },
      ],
    });
    await storage.scheduler.schedule({
      dedupeKey: "late",
      command: {
        type: "RemindCustomer",
        aggregateId: "c-1",
        payload: { customerId: "c-1", email: "ada@example.com" },
      },
      executeAt: new Date(START.getTime() + 86_400_000),
      context: { correlationId: "c", causationId: "c", depth: 0 },
    });
    await app.app.runUntilIdle();
    expect(JSON.stringify(await raw(adapter))).toContain("ada@example.com");
    expect(await app.app.nextDueAt()).not.toBeNull();

    app.clock.advance(BACKFILL_FOLLOW_INTERVAL_MS);
    await app.app.runUntilIdle();
    expect(JSON.stringify(await raw(adapter))).not.toContain("ada@example.com");
    expect(JSON.stringify(await storage.scheduler.list())).not.toContain("ada@example.com");
  });

  it("lets one instance walk at a time, and hands the walk over when it stops", async () => {
    const adapter = memory();
    const before = await start({ adapter, marks: unmarked });
    for (const customerId of ["c-1", "c-2", "c-3"]) {
      await before.commands.registerCustomer?.({
        customerId,
        email: `${customerId}@example.com`,
        name: customerId,
      });
    }
    await before.stop();
    const runtime: RuntimeConfig = { dispatcher: { batchSize: 1 } };
    const one = await start({ adapter, marks: marked, runtime });
    const other = await start({ adapter, marks: marked, runtime });
    await one.app.runUntilIdle({ maxPasses: 1 });
    await other.app.runUntilIdle();
    expect(await other.app.getLag()).toMatchObject({
      personalDataBackfill: { position: 1, caughtUp: false },
    });
    expect(await other.app.nextDueAt()).toEqual(new Date(START.getTime() + BACKFILL_LEASE_MS));
    await one.stop();
    await other.app.runUntilIdle();
    expect(await other.app.getLag()).toMatchObject({
      personalDataBackfill: { position: 3, caughtUp: true },
    });
    expect(JSON.stringify(await raw(adapter))).not.toContain("@example.com");
  });

  it("holds the walk for every instance after a failure, longer after each, until one succeeds", async () => {
    const adapter = memory();
    const before = await start({ adapter, marks: unmarked });
    await before.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await before.stop();
    let down = true;
    const keyWrapper = defineKeyWrapper(async () => ({
      kid: "test",
      wrap: async (key) => {
        if (down) throw new Error("key service is down");
        return key;
      },
      unwrap: async ({ wrapped }) => wrapped,
    }));
    const { logger, logs } = recording();
    const runtime: RuntimeConfig = { personalData: { keyWrapper } };
    const one = await start({ adapter, marks: marked, runtime, logger });
    await one.app.runUntilIdle();
    expect(logs).toContainEqual([
      "error",
      "personal data written before its marks could not be sealed",
      expect.objectContaining({ errorName: "Error" }),
    ]);
    expect(await one.app.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    await one.stop();

    const other = await start({ adapter, marks: marked, runtime });
    await other.app.runUntilIdle();
    expect(await other.app.getLag()).toMatchObject({ personalDataBackfill: { position: 0 } });
    expect(await other.app.nextDueAt()).toEqual(new Date(START.getTime() + HOLD_MS));
    other.clock.advance(HOLD_MS);
    await other.app.runUntilIdle();
    expect(await other.app.nextDueAt()).toEqual(new Date(START.getTime() + 3 * HOLD_MS));
    down = false;
    other.clock.advance(2 * HOLD_MS);
    await other.app.runUntilIdle();
    expect(await other.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: true } });
    const storage = await adapter.createStorage();
    const rows = (await storage.checkpointStore.list()).map(({ subscriber }) => subscriber);
    expect(rows.some((row) => row.endsWith(":held-until") || row.endsWith(":attempts"))).toBe(
      false,
    );
  });

  it("records the activity of whom an event names once resealed, for the retention", async () => {
    const adapter = memory();
    const before = await start({ adapter, marks: unmarked });
    await before.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await before.stop();
    const after = await start({
      adapter,
      marks: marked,
      runtime: { personalData: { retention: "30d" } },
      now: new Date(START.getTime() + MINUTE_MS),
    });
    await after.app.runUntilIdle();
    const storage = await adapter.createStorage();
    expect(await storage.persons.get("c-1")).toMatchObject({
      lastActiveAt: START.toISOString(),
      forgottenAt: null,
    });
  });

  it("leaves in the clear, and says so, what names no person to seal it under", async () => {
    const adapter = memory();
    const before = await start({ adapter, marks: unmarked });
    await before.commands.placeOrder?.({ orderId: "o-1", customerId: "", address: "Bilbao" });
    await before.stop();
    const { logger, logs } = recording();
    const after = await start({ adapter, marks: marked, logger });
    await after.app.runUntilIdle();
    const order = (await raw(adapter)).find((event) => event.type === "OrderPlaced");
    expect(order).toMatchObject({ person: null, payload: { customerId: "", address: "Bilbao" } });
    expect(logs).toContainEqual([
      "warn",
      "personal data written before its marks names no person and stays in the clear",
      expect.objectContaining({ events: 1, eventTypes: ["order.OrderPlaced"] }),
    ]);
    expect(await after.app.getLag()).toMatchObject({ personalDataBackfill: { caughtUp: true } });
  });

  it("does not run without marks", async () => {
    const adapter = memory();
    const app = await start({ adapter, marks: unmarked });
    await app.commands.registerCustomer?.({
      customerId: "c-1",
      email: "ada@example.com",
      name: "Ada",
    });
    await app.app.runUntilIdle();
    expect(await app.app.getLag()).toMatchObject({ personalDataBackfill: null });
    expect(await app.app.nextDueAt()).toBeNull();
  });
});
