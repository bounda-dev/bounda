import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../config/types.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataForgottenPayload } from "../../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { ReactionForgetFunction } from "../../modules/policy.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { RETENTION_SUBSCRIBER } from "./retention.ts";

const DAY = 86_400_000;

// The policy throws once after it forgets, so its first attempt never commits.
let policyFailures = 0;

const noted = ({ z, personal }: EventPayloadArgs) =>
  z.object({ note: personal(z.string()).optional() });

const emits =
  (event: string) =>
  ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
    events[event]?.({ note: "kept" }),
  ];

const customerCommand = (event: string) => ({
  module: {
    payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
    handler: emits(event),
  },
});

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerTouched: { payload: noted, evolve: () => ({}) },
        accountClosed: { payload: noted, evolve: () => ({}) },
        accountReopened: { payload: noted, evolve: () => ({}) },
        erasureRequested: { payload: noted, evolve: () => ({}) },
      },
      commands: {
        touchCustomer: customerCommand("customerTouched"),
        closeAccount: customerCommand("accountClosed"),
        reopenAccount: customerCommand("accountReopened"),
        requestErasure: customerCommand("erasureRequested"),
      },
      policies: {
        forgetOnErasureRequested: {
          module: {
            on: "ErasureRequested",
            handler: async ({
              event,
              forget,
            }: {
              event: StoredEvent;
              forget: ReactionForgetFunction;
            }) => {
              await forget(event.aggregateId);
              if (policyFailures > 0) {
                policyFailures -= 1;
                throw new Error("mailer is down");
              }
            },
          },
        },
      },
      processes: {
        erasure: {
          module: {
            config: () => ({
              startedBy: ["customer.AccountClosed"],
              completedBy: ["customer.AccountReopened"],
              timeout: "30d",
            }),
            state: ({ z }: ProcessStateArgs) => z.object({}),
          },
          handlers: {},
          deadlines: {
            timeout: {
              handler: async ({
                aggregateId,
                forget,
              }: {
                aggregateId: string;
                forget: ReactionForgetFunction;
              }) => {
                await forget(aggregateId);
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
} as unknown as Registry;

const categorized = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerTouched: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              note: personal(z.string()),
              nickname: personal(z.string(), { category: "profile" as never }),
            }),
          evolve: () => ({}),
        },
      },
      commands: {
        touchCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.customerTouched?.({ note: "kept", nickname: "Al" }),
            ],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
  personalData: { categories: { profile: { basis: "consent", retention: "10d" } } },
} as unknown as Registry;

const retention: Omit<Config, "storage" | "ports"> = {
  runtime: { personalData: { retention: "30d" } },
};

const setUp = async (config = retention, booted = registry) => {
  const adapter = memory();
  const { app, clock } = await createTestApp({ registry: booted, config, adapter });
  const storage = await adapter.createStorage();
  const commands = app.commands as unknown as Record<
    string,
    (payload: { customerId: string }) => Promise<unknown>
  >;
  const run = async (command: string, customerId: string): Promise<void> => {
    await commands[command]?.({ customerId });
    await app.runUntilIdle();
  };
  const advance = async (days: number): Promise<void> => {
    clock.set(new Date(clock.now().getTime() + days * DAY));
    await app.runUntilIdle();
  };
  const forgotten = async (): Promise<readonly PersonalDataForgottenPayload[]> =>
    (await app.events.read({ limit: 1000 }))
      .filter((event) => event.type === "PersonalDataForgotten")
      .map((event) => event.payload as PersonalDataForgottenPayload);
  const reasons = async (): Promise<readonly (readonly [string, string])[]> =>
    (await forgotten()).map(({ personId, reason }) => [personId, reason]);
  stops.push(() => app.stop());
  return { app, clock, storage, run, advance, forgotten, reasons };
};

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  policyFailures = 0;
  for (const stop of stops.splice(0)) await stop();
});

describe("retention", () => {
  it("forgets a person inactive past the retention once the test moves the clock, and not one active since", async () => {
    const { run, advance, reasons, storage } = await setUp();
    await run("touchCustomer", "c-1");
    await run("touchCustomer", "c-2");
    await advance(20);
    await run("touchCustomer", "c-2");
    await advance(9);
    expect(await reasons()).toEqual([]);
    await advance(2);
    expect(await reasons()).toEqual([["c-1", "retention"]]);
    expect(await storage.personalKeys.get("c-1", "default")).toBeNull();
    expect(await storage.personalKeys.get("c-2", "default")).not.toBeNull();
    await advance(20);
    expect(await reasons()).toEqual([
      ["c-1", "retention"],
      ["c-2", "retention"],
    ]);
  });

  it("never moves a test's clock to a retention deadline, which nextDueAt still names", async () => {
    const { app, clock, run, reasons } = await setUp();
    const start = clock.now();
    await run("touchCustomer", "c-1");
    expect(await app.runUntilIdle()).toMatchObject({ idle: true });
    expect(clock.now()).toEqual(start);
    expect(await reasons()).toEqual([]);
    expect(await app.nextDueAt()).toEqual(new Date(start.getTime() + 30 * DAY));
  });

  it("moves a test's clock past a retention deadline only on its way to a retry", async () => {
    const { app, clock, run } = await setUp({
      runtime: {
        personalData: { retention: "30d" },
        policies: {
          retry: { strategy: "fixed", maxAttempts: 2, baseDelay: "40d", maxDelay: "40d" },
        },
      },
    });
    const start = clock.now().getTime();
    await run("touchCustomer", "c-1");
    policyFailures = 1;
    await run("requestErasure", "c-2");
    expect(clock.now()).toEqual(new Date(start + 40 * DAY));
    const retained = (await app.events.read({ limit: 1000 })).filter(
      (event) =>
        event.type === "PersonalDataForgotten" &&
        (event.payload as PersonalDataForgottenPayload).reason === "retention",
    );
    expect(retained.map(({ aggregateId, timestamp }) => [aggregateId, timestamp])).toEqual([
      ["c-1", new Date(start + 40 * DAY).toISOString()],
    ]);
  });

  it("names in nextDueAt whichever comes first, a scheduled command or a retention deadline", async () => {
    const { app, clock, run } = await setUp({ runtime: { personalData: { retention: "40d" } } });
    const start = clock.now().getTime();
    await run("closeAccount", "c-1");
    expect(await app.nextDueAt()).toEqual(new Date(start + 30 * DAY));
    await run("reopenAccount", "c-1");
    expect(await app.nextDueAt()).toEqual(new Date(start + 40 * DAY));
    clock.set(new Date(start + 20 * DAY));
    await run("closeAccount", "c-2");
    expect(await app.nextDueAt()).toEqual(new Date(start + 40 * DAY));
  });

  it("counts a person forgotten as work done, so a pass that forgets is not idle", async () => {
    const { app, clock, run } = await setUp();
    await run("touchCustomer", "c-1");
    clock.advance(31 * DAY);
    expect(await app.runUntilIdle({ maxPasses: 1 })).toMatchObject({ idle: false });
    expect(await app.runUntilIdle()).toMatchObject({ idle: true });
  });

  it("leaves a restricted person alone, and forgets them once the restriction is lifted", async () => {
    const { app, run, advance, reasons } = await setUp();
    await run("touchCustomer", "c-1");
    await app.restrict("c-1");
    await advance(40);
    expect(await reasons()).toEqual([]);
    expect(await app.nextDueAt()).toBeNull();
    await app.unrestrict("c-1");
    await app.runUntilIdle();
    expect(await reasons()).toEqual([["c-1", "retention"]]);
  });

  it("starts a new clock for a person active again after being forgotten", async () => {
    const { app, run, advance, reasons, clock } = await setUp();
    await run("touchCustomer", "c-1");
    await app.forget("c-1");
    await run("touchCustomer", "c-1");
    const activeAgain = clock.now().getTime();
    await advance(29);
    expect(await reasons()).toEqual([["c-1", "requested"]]);
    expect(await app.nextDueAt()).toEqual(new Date(activeAgain + 30 * DAY));
    await advance(2);
    expect(await reasons()).toEqual([
      ["c-1", "requested"],
      ["c-1", "retention"],
    ]);
    await advance(60);
    expect(await reasons()).toHaveLength(2);
  });

  it("records the same rows when the subscriber starts over from the first event", async () => {
    const { app, run, advance, storage } = await setUp();
    await run("touchCustomer", "c-1");
    await run("touchCustomer", "c-2");
    await advance(31);
    await run("touchCustomer", "c-2");
    await app.restrict("c-3");
    await app.runUntilIdle();
    const rows = () => Promise.all(["c-1", "c-2", "c-3"].map((id) => storage.persons.get(id)));
    const recorded = await rows();
    expect(recorded.map((row) => row?.forgottenAt ?? null)).toEqual([
      expect.any(String),
      null,
      null,
    ]);
    await storage.checkpointStore.set(RETENTION_SUBSCRIBER, 0);
    await app.runUntilIdle();
    expect(await rows()).toEqual(recorded);
  });

  it("forgets a declared category idle past its own retention, leaving the person's other data", async () => {
    const { app, run, advance, forgotten, storage, clock } = await setUp({}, categorized);
    const start = clock.now().getTime();
    await run("touchCustomer", "c-1");
    expect(await app.nextDueAt()).toEqual(new Date(start + 10 * DAY));
    await advance(11);
    expect(await forgotten()).toEqual([
      expect.objectContaining({
        personId: "c-1",
        reason: "retention",
        whole: false,
        categories: ["profile"],
      }),
    ]);
    expect(await storage.personalKeys.get("c-1", "profile")).toBeNull();
    expect(await storage.personalKeys.get("c-1", "default")).not.toBeNull();
    expect((await storage.persons.get("c-1"))?.forgottenAt).toBeNull();
    expect(await app.nextDueAt()).toBeNull();
  });

  it("runs no retention without the setting or a declared category: nothing is recorded, due or forgotten", async () => {
    const { app, run, advance, reasons, storage } = await setUp({});
    await run("touchCustomer", "c-1");
    expect(await app.nextDueAt()).toBeNull();
    await advance(3_650);
    expect(await reasons()).toEqual([]);
    expect(await storage.persons.get("c-1")).toBeNull();
    expect((await app.getLag()).subscribers.map(({ subscriber }) => subscriber)).not.toContain(
      RETENTION_SUBSCRIBER,
    );
  });
});

describe("forget in a reaction", () => {
  it("forgets at a process's timeout, as the domain decides, unless the process completed first", async () => {
    const { run, advance, forgotten, storage } = await setUp({});
    await run("closeAccount", "c-1");
    await run("closeAccount", "c-2");
    await run("reopenAccount", "c-2");
    await advance(29);
    expect(await forgotten()).toEqual([]);
    await advance(2);
    expect(await forgotten()).toEqual([
      {
        personId: "c-1",
        reason: "requested",
        whole: true,
        categories: ["default"],
        retained: [],
        expired: [],
        fingerprints: [expect.any(String)],
        cancelledCommands: [],
        removedDeadLetters: [],
      },
    ]);
    expect(await storage.personalKeys.get("c-1", "default")).toBeNull();
    expect(await storage.personalKeys.get("c-2", "default")).not.toBeNull();
  });

  it("forgets once from a policy whose first attempt failed after forgetting", async () => {
    const { app, run, reasons, storage } = await setUp({
      runtime: { policies: { retry: { strategy: "fixed", maxAttempts: 3, baseDelay: "1s" } } },
    });
    policyFailures = 1;
    await run("requestErasure", "c-1");
    expect(policyFailures).toBe(0);
    expect(await reasons()).toEqual([["c-1", "requested"]]);
    expect(await storage.personalKeys.get("c-1", "default")).toBeNull();
    expect(await app.deadLetters.list()).toEqual([]);
    const [event] = (await app.events.read({ limit: 1000 })).filter(
      (stored) => stored.type === "PersonalDataForgotten",
    );
    const [cause] = (await app.events.read({ limit: 1000 })).filter(
      (stored) => stored.type === "ErasureRequested",
    );
    expect(event?.metadata).toMatchObject({
      causationId: cause?.id,
      correlationId: cause?.metadata.correlationId,
      depth: 1,
    });
  });
});
