import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import type { ErrorText } from "../config/types.ts";
import { createFixedClock } from "../contracts/clock.ts";
import { createSequentialIdGenerator } from "../contracts/ids.ts";
import type { LogFields } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../modules/payload.ts";
import type { CreateArgs } from "../modules/port.ts";
import type { ProcessStateArgs } from "../modules/process.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { createTestApp } from "../testing/index.ts";
import { createApp } from "./app.ts";
import { rebuildReadModel } from "./read-model/rebuild.ts";
import { errorFields } from "./shared/error-fields.ts";
import { type FakeTelemetry, installFakeTelemetry } from "./telemetry-fake.ts";
import { advanceUntilWaiting, createKernelHarness, createRecordingLogger } from "./test-support.ts";

const EMAIL = "ana@example.com";

interface Builders {
  readonly [name: string]: (payload?: unknown) => unknown;
}

interface Registered {
  readonly aggregateId: string;
  readonly payload: { readonly email: string | null };
}

// Every handler quotes the personal field it read, as a careless one does.
const refuse = (email: string | null): never => {
  throw new Error(`cannot reach ${email ?? "nobody"}`);
};

const registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.email()) }),
          evolve: () => ({}),
        },
        customerReminded: {
          payload: ({ z }: EventPayloadArgs) => z.object({}),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: ({ command, events }: { command: Registered; events: Builders }) => [
              events.customerRegistered?.(command.payload),
            ],
          },
        },
        greetCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: ({ command }: { command: Registered }) => refuse(command.payload.email),
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: ({ command }: { command: Registered }) => refuse(command.payload.email),
          },
        },
      },
      policies: {
        welcomeOnCustomerRegistered: {
          module: {
            handler: ({ event }: { event: Registered }) => refuse(event.payload.email),
          },
        },
        followUpOnCustomerRegistered: {
          module: {
            delay: "1m",
            handler: ({ event }: { event: Registered }) => refuse(event.payload.email),
          },
        },
      },
      processes: {
        onboarding: {
          module: {
            config: ({
              events,
            }: {
              events: { customer: { CustomerRegistered: string; CustomerReminded: string } };
            }) => ({
              startedBy: [events.customer.CustomerRegistered],
              completedBy: [events.customer.CustomerReminded],
              timeout: "1h",
            }),
            state: ({ z, person, personal }: ProcessStateArgs) =>
              z.object({
                customerId: person(z.string()).nullable().default(null),
                email: personal(z.email()).nullable().default(null),
              }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: ({ event }: { event: Registered }) => ({
                  customerId: event.aggregateId,
                  email: event.payload.email,
                }),
              },
            },
          },
          deadlines: {
            timeout: {
              handler: ({ state }: { state: { email: string | null } }) => refuse(state.email),
            },
          },
        },
        audit: {
          module: {
            config: ({
              events,
            }: {
              events: { customer: { CustomerRegistered: string; CustomerReminded: string } };
            }) => ({
              startedBy: [events.customer.CustomerRegistered],
              completedBy: [events.customer.CustomerReminded],
            }),
            state: ({ z }: ProcessStateArgs) => z.object({}),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: ({ event }: { event: Registered }) => refuse(event.payload.email),
              },
            },
          },
        },
      },
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({ event }: { event: Registered }) => refuse(event.payload.email),
          },
        },
      },
      queries: {},
    },
  },
} as const satisfies Registry;

const ana = { customerId: "c-1", email: EMAIL };

const RETRY_TWICE = { strategy: "fixed", maxAttempts: 2, baseDelay: "1s" } as const;
const RETRY_TWICE_PASSES = [1, 2];

// Fails the first background pass of the dispatcher and of the worker the way a store's error can:
// quoting what it was handed.
const leakyStore = (): Adapter => {
  const base = memory();
  return {
    ...base,
    createStorage: async () => {
      const storage = await base.createStorage();
      let readFails = true;
      let claimFails = true;
      return {
        ...storage,
        eventStore: {
          ...storage.eventStore,
          readAll: async (args) => {
            if (readFails) {
              readFails = false;
              throw new Error(`row ${EMAIL} is locked`);
            }
            return storage.eventStore.readAll(args);
          },
        },
        scheduler: {
          ...storage.scheduler,
          claimDue: async (args) => {
            if (claimFails) {
              claimFails = false;
              throw new Error(`row ${EMAIL} is locked`);
            }
            return storage.scheduler.claimDue(args);
          },
        },
      };
    },
  };
};

const start = async ({
  errorText,
  adapter = memory(),
}: {
  readonly errorText?: ErrorText;
  readonly adapter?: Adapter;
}) => {
  const clock = createFixedClock();
  const { logger, entries } = createRecordingLogger();
  const app = await createApp({
    registry,
    config: {
      storage: adapter,
      runtime: {
        policies: { retry: RETRY_TWICE },
        processes: { retry: RETRY_TWICE },
        dispatcher: { backoff: { baseDelay: "1s", maxDelay: "1s" } },
        ...(errorText === undefined ? {} : { telemetry: { errorText } }),
      },
    },
    logger,
    clock,
    ids: createSequentialIdGenerator(),
  });
  return { app, clock, entries };
};

let telemetry: FakeTelemetry | undefined;

afterEach(() => {
  telemetry?.restore();
  telemetry = undefined;
});

const everythingSeen = async (entries: readonly unknown[], lag: unknown): Promise<string> => {
  const seen = telemetry as FakeTelemetry;
  return JSON.stringify({
    entries,
    spans: seen.spans,
    spanEvents: seen.spanEvents,
    counts: seen.counts,
    lag,
  });
};

// Every path a handler's error can take: a command, a policy run now and one delayed through the
// scheduler, a process handler and its deadline, a projection, a scheduled command, each retried
// before it gives up.
const failEverywhere = async ({ app, clock }: Awaited<ReturnType<typeof start>>) => {
  await app.commands.registerCustomer(ana);
  await expect(app.commands.greetCustomer(ana)).rejects.toThrow(EMAIL);
  await app.commands.remindCustomer(ana, { delay: "1m" });
  await app.runUntilIdle();
  clock.advance(60 * 60_000);
  await app.runUntilIdle();
  // Past each retry's back-off, until every scheduled run gave up.
  for (const _ of RETRY_TWICE_PASSES) {
    clock.advance(1_000);
    await app.runUntilIdle();
  }
};

describe("the text of a handler's error that quotes personal data", () => {
  it("reaches no log line, span, span event, metric or lag by default, on every path", async () => {
    telemetry = installFakeTelemetry();
    const started = await start({});
    await failEverywhere(started);
    const { app, entries } = started;
    const lag = await app.getLag();
    const seen = await everythingSeen(entries, lag);
    expect(seen).not.toContain(EMAIL);
    expect(seen).not.toContain("cannot reach");

    const messages = entries.map((entry) => entry.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "projection failed",
        "subscriber failed; batch will be redelivered",
        "policy failed; will retry",
        "process handler failed; will retry",
        "policy dead-lettered",
        "process dead-lettered",
        "scheduled command failed; rescheduled",
        "scheduled command dropped",
      ]),
    );
    for (const entry of entries.filter((line) => line.fields?.errorName !== undefined)) {
      expect(entry.fields).not.toHaveProperty("errorMessage");
      expect(entry.fields).not.toHaveProperty("errorStack");
    }
    const failing = lag.subscribers.find(
      (subscriber) => subscriber.subscriber === "projection:customers",
    )?.failing;
    expect(failing).toMatchObject({ errorName: "Error" });
    expect(failing).not.toHaveProperty("errorMessage");

    const failedSpans = telemetry.spans.filter((span) => span.status.code === 2);
    expect(failedSpans.map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "bounda.command GreetCustomer",
        "bounda.policy customer.welcomeOnCustomerRegistered",
        "bounda.policy customer.followUpOnCustomerRegistered",
        "bounda.projection customers.customer.customerRegistered",
        "bounda.process customer.onboarding at timeout",
        "bounda.process customer.audit",
        "bounda.scheduled RemindCustomer",
      ]),
    );
    for (const span of failedSpans) {
      expect(span.attributes["error.type"]).toBe("Error");
      expect(span.status.message).toBe("Error");
      expect(span.exceptions).toEqual([]);
    }
    for (const event of telemetry.spanEvents.filter((event) => event.name === "exception")) {
      expect(event.attributes).toStrictEqual({ "exception.type": "Error" });
    }
    await app.stop();
  });

  it("is told by the letter's id in the log line, which opens the sealed text", async () => {
    const started = await start({});
    await failEverywhere(started);
    const { app, entries } = started;
    const filed = entries.filter((entry) =>
      ["policy dead-lettered", "process dead-lettered", "scheduled command dropped"].includes(
        entry.message,
      ),
    );
    expect(filed.length).toBeGreaterThanOrEqual(4);
    for (const entry of filed) {
      const letterId = entry.fields?.letterId as string;
      expect(entry.fields).toMatchObject({ errorName: "Error" });
      expect((await app.deadLetters.get(letterId))?.errorMessage).toBe(`cannot reach ${EMAIL}`);
    }
    await app.stop();
  });

  it("reaches the logs and spans only when errorText is include", async () => {
    telemetry = installFakeTelemetry();
    const started = await start({ errorText: "include" });
    await failEverywhere(started);
    const { app, entries } = started;
    expect(entries.find((entry) => entry.message === "projection failed")?.fields).toMatchObject({
      errorName: "Error",
      errorMessage: `cannot reach ${EMAIL}`,
      errorStack: expect.stringContaining(EMAIL),
    });
    const greeted = telemetry.spans.find((span) => span.name === "bounda.command GreetCustomer");
    expect(greeted?.status.message).toBe(`cannot reach ${EMAIL}`);
    expect(
      telemetry.spanEvents.find(
        (event) => event.name === "exception" && event.span === "bounda.command GreetCustomer",
      )?.attributes,
    ).toEqual({
      "exception.type": "Error",
      "exception.message": `cannot reach ${EMAIL}`,
      "exception.stacktrace": expect.stringContaining(EMAIL),
    });
    expect(
      (await app.getLag()).subscribers.find(
        (subscriber) => subscriber.subscriber === "projection:customers",
      )?.failing,
    ).toMatchObject({ errorMessage: `cannot reach ${EMAIL}` });
    await app.stop();
  });

  it("reaches the logs of an app from createTestApp unless its configuration omits it", async () => {
    const included = createRecordingLogger();
    const { app } = await createTestApp({ registry, logger: included.logger });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    expect(JSON.stringify(included.entries)).toContain(EMAIL);
    await app.stop();

    const omitted = createRecordingLogger();
    const { app: quiet } = await createTestApp({
      registry,
      logger: omitted.logger,
      config: { runtime: { telemetry: { errorText: "omit" } } },
    });
    await quiet.commands.registerCustomer(ana);
    await quiet.runUntilIdle();
    expect(JSON.stringify(omitted.entries)).not.toContain(EMAIL);
    await quiet.stop();
  });

  it("reaches no log line of the dispatcher's or the worker's background pass when the store's error quotes it", async () => {
    telemetry = installFakeTelemetry();
    const started = await start({ adapter: leakyStore() });
    const { app, clock, entries } = started;
    await app.commands.remindCustomer(ana, { delay: "0s" });
    app.start();
    await advanceUntilWaiting(clock, 1_000);
    await app.stop();
    const passes = entries.filter((entry) =>
      ["dispatcher pass failed", "scheduled command worker failed"].includes(entry.message),
    );
    expect(passes.map((entry) => [entry.message, entry.fields])).toEqual(
      expect.arrayContaining([
        ["dispatcher pass failed", { errorName: "Error" }],
        ["scheduled command worker failed", { errorName: "Error" }],
      ]),
    );
    expect(await everythingSeen(entries, null)).not.toContain(EMAIL);
  });

  it("reaches no log line or span of a rebuild whose projection throws", async () => {
    telemetry = installFakeTelemetry();
    const adapter = memory();
    const seeded = await start({ adapter });
    await seeded.app.commands.registerCustomer(ana);
    await seeded.app.stop();
    const { logger, entries } = createRecordingLogger();
    await expect(
      rebuildReadModel({
        registry,
        config: { storage: adapter },
        name: "customers",
        logger,
      }),
    ).rejects.toThrow(EMAIL);
    expect(entries.find((entry) => entry.message === "projection failed")?.fields).toMatchObject({
      errorName: "Error",
    });
    expect(await everythingSeen(entries, null)).not.toContain(EMAIL);
  });

  it("keeps the fields a port's code logs, reducing only the errors among them", async () => {
    const entries: { readonly message: string; readonly fields?: LogFields }[] = [];
    const record = (message: string, fields?: LogFields): void => {
      entries.push({ message, ...(fields === undefined ? {} : { fields }) });
    };
    const logger = { debug: record, info: record, warn: record, error: record };
    const app = await createApp({
      registry: {
        aggregates: {
          shop: {
            events: {},
            commands: {},
            policies: {},
            processes: {},
            ports: {
              mailer: {
                smtp: {
                  create: ({ logger: portLogger }: CreateArgs) => {
                    portLogger.warn("smtp slow", {
                      error: "timeout after 5s",
                      cause: new Error(`refused ${EMAIL}`),
                    });
                    return { send: () => undefined };
                  },
                },
              },
            },
          },
        },
        readModels: {},
      } satisfies Registry,
      config: { storage: memory(), ports: { shop: { mailer: "smtp" } } },
      logger,
    });
    expect(entries.find((entry) => entry.message === "smtp slow")?.fields).toEqual({
      error: "timeout after 5s",
      cause: { errorName: "Error" },
    });
    await app.stop();
  });

  it("names Bounda's own error of an unknown command with its message", async () => {
    const { pipeline } = await createKernelHarness({});
    const unknown = await pipeline.dispatch({ type: "Nope", payload: {} }).catch((e: unknown) => e);
    expect(errorFields({ error: unknown })).toEqual({
      errorName: "NotFoundError",
      errorCode: "NOT_FOUND",
      errorMessage: 'Unknown command "Nope"',
    });
  });
});
