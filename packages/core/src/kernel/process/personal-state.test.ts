import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import {
  ConfigurationError,
  PROCESSING_RESTRICTED,
  ValidationError,
} from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { isSealed } from "../personal-data/crypto.ts";
import { PROCESS_EVENTS } from "./lifecycle.ts";

interface OnboardingState {
  readonly customerId: string | null;
  readonly email: string | null;
  readonly nudges: number;
  readonly reminder: string | null;
}

interface StepArgs {
  readonly state: OnboardingState;
  readonly after: (delay: string) => string;
}

const seen: (string | null)[] = [];
let startWith: (payload: { customerId: string; email: string }) => Partial<OnboardingState> = (
  payload,
) => payload;
let remindFails = false;
// Runs once inside the next nudge or reminder, which then fails for good with the email it read.
let interrupt: (() => Promise<unknown>) | null = null;

const interrupted = async (state: OnboardingState): Promise<void> => {
  const run = interrupt;
  interrupt = null;
  if (run === null) return;
  await run();
  throw new ValidationError(`could not reach ${state.email ?? "nobody"}`, []);
};

const emailIn = (payload: unknown): unknown =>
  (payload as { state?: { email?: unknown } }).state?.email;

const registry = {
  aggregates: {
    signup: {
      events: {
        signupStarted: {
          payload: ({ z, person, personal }: EventPayloadArgs) =>
            z.object({ customerId: person(z.string()), email: personal(z.email()) }),
          evolve: ({ state }: { state: object }) => state,
        },
        signupNudged: { evolve: ({ state }: { state: object }) => state },
        signupConfirmed: { evolve: ({ state }: { state: object }) => state },
      },
      commands: {
        startSignup: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ signupId: z.string(), customerId: z.string(), email: z.email() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string; email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [
              events.signupStarted?.({
                customerId: command.payload.customerId,
                email: command.payload.email,
              }),
            ],
          },
        },
        nudgeSignup: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ signupId: z.string() }),
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.signupNudged?.(),
            ],
          },
        },
        confirmSignup: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ signupId: z.string() }),
            handler: ({ events }: { events: Record<string, (payload?: unknown) => unknown> }) => [
              events.signupConfirmed?.(),
            ],
          },
        },
      },
      policies: {},
      processes: {
        onboarding: {
          module: {
            config: ({
              events,
            }: {
              events: { signup: Record<"SignupStarted" | "SignupConfirmed", string> };
            }) => ({
              startedBy: [events.signup.SignupStarted],
              completedBy: [events.signup.SignupConfirmed],
              timeout: "48h",
            }),
            state: ({ z, deadline, personal, person }: ProcessStateArgs) =>
              z.object({
                customerId: person(z.string()).nullable().default(null),
                email: personal(z.email()).nullable().default(null),
                nudges: z.int().default(0),
                reminder: deadline(),
              }),
          },
          handlers: {
            signup: {
              signupStarted: {
                handler: ({
                  event,
                  after,
                }: StepArgs & {
                  event: { payload: { customerId: string; email: string } };
                }) => ({ reminder: after("1h"), ...startWith(event.payload) }),
              },
              signupNudged: {
                handler: async ({ state }: StepArgs) => {
                  await interrupted(state);
                  seen.push(state.email);
                  return { nudges: state.nudges + 1 };
                },
              },
            },
          },
          deadlines: {
            reminder: {
              handler: async ({ state }: StepArgs) => {
                await interrupted(state);
                seen.push(state.email);
                if (remindFails) throw new Error(`could not remind ${state.email ?? "nobody"}`);
                return { reminder: null };
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
} as const satisfies Registry;

const STREAM = "process:signup.onboarding";
const HOUR_MS = 60 * 60 * 1000;

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

afterEach(() => {
  seen.length = 0;
  startWith = (payload) => payload;
  remindFails = false;
  interrupt = null;
});

describe.each(adapters)("a process state with personal fields on %s", (_name, adapterOf) => {
  const setup = async () => {
    const adapter = adapterOf();
    const storage = await adapter.createStorage();
    const test = await createTestApp({ registry, adapter });
    await test.app.commands.startSignup({
      signupId: "s-1",
      customerId: "c-1",
      email: "ada@example.com",
    });
    await test.app.runUntilIdle();
    const stream = async () =>
      (await storage.eventStore.load({ aggregateType: STREAM, aggregateId: "s-1" })).events;
    return { ...test, storage, stream };
  };

  it("seals them in the lifecycle events under whom the state names, and opens them for its handlers", async () => {
    const { app, stream } = await setup();
    await app.commands.nudgeSignup({ signupId: "s-1" });
    await app.runUntilIdle();

    expect(seen).toEqual(["ada@example.com"]);
    const events = await stream();
    const handled = events.filter((event) => event.type === PROCESS_EVENTS.handled);
    expect(handled).toHaveLength(2);
    for (const event of handled) {
      const state = (event.payload as { state: Record<string, unknown> }).state;
      expect(isSealed(state.email)).toBe(true);
      expect(state.customerId).toBe("c-1");
      expect(event.person).toBe("c-1");
    }
    const started = events.find((event) => event.type === PROCESS_EVENTS.started);
    expect(started?.person).toBeNull();
    await app.stop();
  });

  it("reads them as null once the person is forgotten, and the instance carries on to its end", async () => {
    const { app, clock, stream } = await setup();
    await app.forget("c-1");
    await app.commands.nudgeSignup({ signupId: "s-1" });
    await app.runUntilIdle();
    clock.advance(HOUR_MS);
    await app.runUntilIdle();
    await app.commands.confirmSignup({ signupId: "s-1" });
    await app.runUntilIdle();

    expect(seen).toEqual([null, null]);
    expect((await app.deadLetters.list()).map((letter) => letter.errorMessage)).toEqual([]);
    const events = await stream();
    expect(events.map((event) => event.type)).toEqual([
      PROCESS_EVENTS.started,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.deadlineReached,
      PROCESS_EVENTS.completed,
    ]);
    const last = events.at(-2)?.payload as { state: Record<string, unknown> };
    expect(last.state).toEqual({ customerId: "c-1", email: null, nudges: 1, reminder: null });
    await app.stop();
  });

  it("exports the fields from every lifecycle event that names the person", async () => {
    const { app } = await setup();
    await app.commands.nudgeSignup({ signupId: "s-1" });
    await app.runUntilIdle();

    const exported = (await app.exportPersonalData("c-1")).events.filter(
      (event) => event.aggregateType === STREAM,
    );
    expect(exported.map((event) => [event.type, event.data])).toEqual([
      [PROCESS_EVENTS.handled, { email: "ada@example.com" }],
      [PROCESS_EVENTS.handled, { email: "ada@example.com" }],
    ]);
    await app.forget("c-1");
    expect(
      (await app.exportPersonalData("c-1")).events
        .filter((event) => event.aggregateType === STREAM)
        .map((event) => event.data),
    ).toEqual([{ email: null }, { email: null }]);
    await app.stop();
  });

  it("refuses a step while the person is restricted, and runs it once the restriction lifts", async () => {
    const { app, stream } = await setup();
    await app.restrict("c-1");
    await app.commands.nudgeSignup({ signupId: "s-1" });
    await app.runUntilIdle();

    expect(seen).toEqual([]);
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      handler: "signup.onboarding",
      errorCode: PROCESSING_RESTRICTED,
      person: "c-1",
    });

    await app.unrestrict("c-1");
    await app.runUntilIdle();
    expect(seen).toEqual(["ada@example.com"]);
    const events = await stream();
    expect(events.slice(-2).map((event) => event.type)).toEqual([
      PROCESS_EVENTS.handled,
      PROCESS_EVENTS.resumed,
    ]);
    expect((events.at(-2)?.payload as { state: OnboardingState } | undefined)?.state.nudges).toBe(
      1,
    );
    await app.stop();
  });

  it("fails a step that sets a personal field while the state names nobody", async () => {
    startWith = ({ email }) => ({ email });
    const { app, stream } = await setup();

    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({ handler: "signup.onboarding", errorCode: "VALIDATION_FAILED" });
    expect(letter?.errorMessage).toBe(
      'Process signup.onboarding holds personal data for s-1 and names no person in "customerId"',
    );
    expect((await stream()).map((event) => emailIn(event.payload))).toEqual([null, undefined]);
    await app.stop();
  });

  it("refuses a deadline while the person is restricted, and runs it once the restriction lifts", async () => {
    const { app, clock } = await setup();
    await app.restrict("c-1");
    clock.advance(HOUR_MS);
    await app.runUntilIdle();

    expect(seen).toEqual([]);
    expect(await app.deadLetters.list()).toMatchObject([
      { eventType: "bounda.ProcessDeadline", errorCode: PROCESSING_RESTRICTED, person: "c-1" },
    ]);
    await app.unrestrict("c-1");
    await app.runUntilIdle();
    expect(seen).toEqual(["ada@example.com"]);
    await app.stop();
  });

  it("refuses reaching the timeout while the person is restricted, though it has no handler", async () => {
    startWith = (payload) => ({ ...payload, reminder: null });
    const { app, clock, stream } = await setup();
    await app.restrict("c-1");
    clock.advance(48 * HOUR_MS);
    await app.runUntilIdle();

    expect(await app.deadLetters.list()).toMatchObject([
      { eventId: "deadline:timeout", errorCode: PROCESSING_RESTRICTED, person: "c-1" },
    ]);
    expect((await stream()).at(-1)?.type).toBe(PROCESS_EVENTS.failed);
    await app.unrestrict("c-1");
    await app.runUntilIdle();
    expect((await stream()).map((event) => event.type)).toContain(PROCESS_EVENTS.timedOut);
    await app.stop();
  });

  it.each([
    [
      "an event's",
      async (test: Awaited<ReturnType<typeof createTestApp<typeof registry>>>) => {
        await test.app.commands.nudgeSignup({ signupId: "s-1" });
        await test.app.runUntilIdle();
      },
    ],
    [
      "a deadline's",
      async (test: Awaited<ReturnType<typeof createTestApp<typeof registry>>>) => {
        test.clock.advance(HOUR_MS);
        await test.app.runUntilIdle();
      },
    ],
  ])("seals %s letter under no key but the one the state was read under", async (_step, run) => {
    const test = await setup();
    interrupt = async () => {
      await test.app.forget("c-1");
      await test.app.commands.startSignup({
        signupId: "s-2",
        customerId: "c-1",
        email: "again@example.com",
      });
    };
    await run(test);

    const letters = await test.app.deadLetters.list();
    expect(letters.map((letter) => [letter.person, letter.errorMessage])).toEqual([["c-1", null]]);
    await test.app.stop();
  });

  it("seals the letter of a failed deadline under whom the state names", async () => {
    remindFails = true;
    const { app, clock, storage } = await setup();
    clock.advance(HOUR_MS);
    await app.runUntilIdle();

    const [letter] = await storage.deadLetterStore.listByPerson("c-1");
    expect(letter?.eventType).toBe("bounda.ProcessDeadline");
    expect(isSealed(letter?.errorMessage)).toBe(true);
    expect((await app.deadLetters.list())[0]?.errorMessage).toBe(
      "could not remind ada@example.com",
    );
    await app.forget("c-1");
    expect((await app.deadLetters.list())[0]?.errorMessage).toBeNull();
    await app.stop();
  });
});

describe("a process state schema with personal fields", () => {
  // Typed as the registry it changes, so the test app's commands stay typed.
  const withState = (state: (args: ProcessStateArgs) => unknown): typeof registry => {
    const { processes, ...signup } = registry.aggregates.signup;
    const changed: Registry = {
      ...registry,
      aggregates: {
        signup: {
          ...signup,
          processes: {
            onboarding: {
              ...processes.onboarding,
              module: { ...processes.onboarding.module, state },
            },
          },
        },
      },
    };
    return changed as typeof registry;
  };

  it("refuses two person fields when the app starts", async () => {
    const state = ({ z, person }: ProcessStateArgs) =>
      z.object({
        buyerId: person(z.string()).nullable().default(null),
        sellerId: person(z.string()).nullable().default(null),
      });
    await expect(createTestApp({ registry: withState(state) })).rejects.toThrow(
      new ConfigurationError(
        'aggregates.signup.processes.onboarding.state: marks "buyerId" and "sellerId" with person; a payload names at most one person',
      ),
    );
  });

  it("refuses a state that starts with personal data or names someone", async () => {
    const starting = [
      ({ z, personal }: ProcessStateArgs) =>
        z.object({ email: personal(z.email()).default("ada@example.com") }),
      ({ z, personal, person }: ProcessStateArgs) =>
        z.object({
          customerId: person(z.string()).nullable().default(null),
          email: personal(z.email()).default("ada@example.com"),
        }),
      ({ z, personal, person }: ProcessStateArgs) =>
        z.object({
          customerId: person(z.string()).default("c-1"),
          email: personal(z.email()).nullable().default(null),
        }),
    ];
    for (const state of starting) {
      await expect(createTestApp({ registry: withState(state) })).rejects.toThrow(
        new ConfigurationError(
          "aggregates.signup.processes.onboarding: the state starts with personal data; default its personal() and person() fields to null",
        ),
      );
    }
  });

  it("lets a handler set a personal field to null, even one whose schema takes no null", async () => {
    startWith = () => ({ email: null });
    const state = ({ z, deadline, personal }: ProcessStateArgs) =>
      z.object({ email: personal(z.email()).optional(), reminder: deadline() });
    const { app } = await createTestApp({ registry: withState(state) });
    await app.commands.startSignup({
      signupId: "s-1",
      customerId: "c-1",
      email: "bob@example.com",
    });
    await app.runUntilIdle();

    expect(await app.deadLetters.list()).toEqual([]);
    await app.stop();
  });
});
