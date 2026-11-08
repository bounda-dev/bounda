import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { StoredEvent } from "../contracts/event.ts";
import type { LogFields } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import type { PersonalDataForgottenEvent } from "../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { CreateArgs } from "../modules/port.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { expectForgotten, NotForgottenError } from "./expect-forgotten.ts";
import { createTestApp } from "./index.ts";
import { recordTelemetry } from "./telemetry.ts";

interface CustomerState {
  readonly email: string | null;
}

interface Row {
  readonly customerId: string;
  readonly email?: string;
  readonly greeting?: string;
}

type Events = Record<string, (payload?: unknown) => unknown>;

interface Mailer {
  welcome(email: string): Promise<void>;
}

const sent: string[] = [];

const registry = {
  aggregates: {
    customer: {
      state: { initialState: { email: null } satisfies CustomerState },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), plan: z.string() }),
          evolve: ({ event }: { event: { payload: { email: string | null } } }) => ({
            email: event.payload.email,
          }),
        },
        customerGreeted: {
          payload: ({ z }: EventPayloadArgs) => z.object({ to: z.string().nullable() }),
          evolve: ({ state }: { state: CustomerState }) => state,
        },
        customerReminded: {
          payload: ({ z }: EventPayloadArgs) => z.object({}),
          evolve: ({ state }: { state: CustomerState }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.email(), plan: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; plan: string } };
              events: Events;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
        greetCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ state, events }: { state: CustomerState; events: Events }) => [
              events.customerGreeted?.({ to: state.email }),
            ],
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: ({ events }: { events: Events }) => [events.customerReminded?.({})],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customerDirectory: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal(),
          greeting: f.string().optional(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<Row>;
            }) => {
              const { email } = event.payload;
              await table.upsert({
                customerId: event.aggregateId,
                ...(email === null ? {} : { email }),
              });
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
              table: Table<Row>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {},
    },
  },
} as const satisfies Registry;

// Copies the email into a field it does not mark, and forgets only the one it marks.
const leaky = {
  ...registry,
  readModels: {
    customerDirectory: {
      ...registry.readModels.customerDirectory,
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<Row>;
            }) => {
              const { email } = event.payload;
              await table.upsert({
                customerId: event.aggregateId,
                ...(email === null ? {} : { email, greeting: `Hello ${email}` }),
              });
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
              table: Table<Row>;
            }) => {
              const row = await table.findOne({ customerId: event.payload.personId });
              if (row === null) return;
              await table.upsert({
                customerId: row.customerId,
                ...(row.greeting === undefined ? {} : { greeting: row.greeting }),
              });
            },
          },
        },
      },
    },
  },
} as const satisfies Registry;

// Logs the address it writes to, which no forgetting reaches.
const chatty = {
  ...registry,
  aggregates: {
    customer: {
      ...registry.aggregates.customer,
      ports: {
        mailer: {
          logging: {
            create: ({ logger }: CreateArgs): Mailer => ({
              welcome: async (email) => {
                sent.push(email);
                logger.info(`welcome sent to ${email}`);
              },
            }),
          },
        },
      },
      policies: {
        welcomeOnCustomerRegistered: {
          module: {
            handler: async ({
              event,
              mailer,
            }: {
              event: { payload: { email: string | null } };
              mailer: Mailer;
            }) => {
              if (event.payload.email !== null) await mailer.welcome(event.payload.email);
            },
          },
          source: "customer",
        },
      },
    },
  },
} as const satisfies Registry;

const ana = { customerId: "c-1", email: "ana@example.com", plan: "pro" };

const rejection = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

const adapters: readonly [string, () => Adapter][] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

describe.each(adapters)("expectForgotten on %s", (_name, adapterOf) => {
  it("resolves once nothing the person had is readable anywhere", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    await app.commands.registerCustomer({ ...ana, customerId: "c-2", email: "bo@example.com" });
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    await expectForgotten(app, "c-1");
    await app.stop();
  });

  it("names the table, row and column of a read model that kept a value in a field it did not mark", async () => {
    const { app } = await createTestApp({ registry: leaky, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).toBeInstanceOf(NotForgottenError);
    expect(error).toMatchObject({
      name: "NotForgottenError",
      personId: "c-1",
      found: [
        {
          value: "ana@example.com",
          store: "bounda_rm_customer_directory",
          row: expect.stringMatching(/^customer_?[iI]d=c-1$/),
          field: expect.stringMatching(/^greeting$/),
        },
      ],
    });
    expect((error as Error).message).toContain("project PersonalDataForgotten");
    expect((error as Error).message).toContain('"ana@example.com" in bounda_rm_customer_directory');
    await app.stop();
  });

  it("names the event that holds a value in a field left unmarked", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    await app.commands.greetCustomer({ customerId: "c-1" });
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).toMatchObject({
      found: [
        {
          value: "ana@example.com",
          store: "bounda_events",
          row: "position=2",
          field: "payload.to",
        },
      ],
    });
    expect((error as Error).message).toContain("mark it personal() in the event's payload");
    await app.stop();
  });

  it("looks for what a scheduled command held, though forgetting cancelled it", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    await app.commands.remindCustomer(
      { customerId: "c-1", email: "ana.alt@example.com" },
      { delay: "1d" },
    );
    await app.forget("c-1");
    await app.runUntilIdle();
    await expectForgotten(app, "c-1");
    const error = await rejection(
      expectForgotten(app, "c-1", { places: { outbox: [{ to: "ANA.ALT@example.com" }] } }),
    );
    expect(error).toMatchObject({
      found: [{ value: "ana.alt@example.com", store: "outbox", row: "as given", field: "[0].to" }],
    });
    await app.stop();
  });

  it("finds a value the app logged", async () => {
    sent.length = 0;
    const logged: [string, LogFields | undefined][] = [];
    const { app } = await createTestApp({
      registry: chatty,
      adapter: adapterOf(),
      ports: { customer: { mailer: "logging" } },
      logger: {
        debug: () => {},
        info: (message, fields) => logged.push([message, fields]),
        warn: () => {},
        error: () => {},
      },
    });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(sent).toEqual(["ana@example.com"]);
    expect(logged).toContainEqual(["welcome sent to ana@example.com", undefined]);
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).toMatchObject({
      found: [
        {
          value: "ana@example.com",
          store: "logs",
          row: expect.stringMatching(/^entry \d+ \(info "welcome sent to ana@example.com"\)$/),
          field: "message",
        },
      ],
    });
    expect((error as Error).message).toContain("log ids, never the data itself");
    await app.stop();
  });

  it("finds a value in a span, with the telemetry recorded", async () => {
    const telemetry = recordTelemetry();
    try {
      const { app } = await createTestApp({ registry, adapter: adapterOf() });
      await app.commands.registerCustomer(ana);
      await app.forget("c-1");
      await app.runUntilIdle();
      await expectForgotten(app, "c-1", { telemetry });
      trace
        .getTracer("test")
        .startSpan("mail", { attributes: { to: "ana@example.com" } })
        .end();
      const error = await rejection(expectForgotten(app, "c-1", { telemetry }));
      expect(error).toMatchObject({
        found: [{ store: "spans", row: expect.stringContaining('"mail"'), field: "attributes.to" }],
      });
      await app.stop();
    } finally {
      telemetry.stop();
    }
  });

  it("refuses a person who still holds their key", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).not.toBeInstanceOf(NotForgottenError);
    expect((error as Error).message).toBe(
      '"c-1" still holds a key: forget them before expectForgotten, which looks only for what was sealed under keys they no longer hold',
    );
    await app.stop();
  });

  it("refuses to pass for want of values, and looks for those it is given", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.forget("c-9");
    const error = await rejection(expectForgotten(app, "c-9"));
    expect((error as Error).message).toContain('found no value of "c-9" to look for');
    await expectForgotten(app, "c-9", { values: ["someone@example.com"] });
    await app.stop();
  });

  it("looks only for what the person had before they were forgotten, not what they gave again", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.commands.registerCustomer({ ...ana, email: "ana.new@example.com" });
    await app.runUntilIdle();
    await expectForgotten(app, "c-1");
    await app.stop();
  });

  it("searches an adapter's tables for the values of an export taken before", async () => {
    const adapter = adapterOf();
    const { app } = await createTestApp({ registry: leaky, adapter });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const before = await app.exportPersonalData("c-1");
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(adapter, "c-1", { before }));
    expect(error).toMatchObject({
      found: [{ value: "ana@example.com", store: "bounda_rm_customer_directory" }],
    });
    await app.stop();
  });
});

describe("expectForgotten", () => {
  it("looks for what an earlier test app over the same storage sealed", async () => {
    // Sequential ids start again in each test app, which only the in-memory store lets through.
    const adapter = memory();
    const first = await createTestApp({ registry: leaky, adapter });
    await first.app.commands.registerCustomer(ana);
    await first.app.runUntilIdle();
    await first.app.stop();
    const { app } = await createTestApp({ registry: leaky, adapter });
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).toMatchObject({
      found: [{ value: "ana@example.com", store: "bounda_rm_customer_directory" }],
    });
    await app.stop();
  });

  it("searches the read models kept in another adapter, and the forget ledger", async () => {
    const readModels = memory();
    const { app } = await createTestApp({
      registry: leaky,
      config: {
        readModels: { customerDirectory: readModels },
        runtime: { personalData: { forgetLedger: { store: memory() } } },
      },
    });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect(error).toMatchObject({ found: [{ store: "bounda_rm_customer_directory" }] });
    const forgetting = (await app.events.read()).find(
      ({ type }) => type === "PersonalDataForgotten",
    );
    const traced = await rejection(expectForgotten(app, "c-1", { values: [forgetting?.id] }));
    expect((traced as NotForgottenError).found).toContainEqual({
      value: forgetting?.id,
      store: "forget ledger",
      row: `eventId=${forgetting?.id}`,
      field: "eventId",
    });
    await app.stop();
  });

  it("leaves a test app refusing a forget ledger kept in the storage's own database", async () => {
    const adapter = memory();
    await expect(
      createTestApp({
        registry,
        adapter,
        config: { runtime: { personalData: { forgetLedger: { store: adapter } } } },
      }),
    ).rejects.toThrow("points at the storage's own database");
  });

  it("refuses anything that is neither a test app nor an adapter", async () => {
    const error = await rejection(expectForgotten({ forget: async () => ({}) } as never, "c-1"));
    expect(error).toBeInstanceOf(TypeError);
  });
});
