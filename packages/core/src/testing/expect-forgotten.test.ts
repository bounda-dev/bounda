import { trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { StoredEvent } from "../contracts/event.ts";
import type { LogFields } from "../contracts/logger.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { defineForgetLedger } from "../kernel/personal-data/forget-ledger.ts";
import { memory } from "../memory/index.ts";
import type { PersonalDataForgottenEvent } from "../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { CreateArgs } from "../modules/port.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { expectForgotten, NotForgottenError, registerTestApp } from "./expect-forgotten.ts";
import { createTestApp } from "./index.ts";
import { recordTelemetry } from "./telemetry.ts";
import { testWitnessOf } from "./witness.ts";

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

// Keeps a handle made from the email in a field it marks, and in the greeting it keeps.
const deriving = {
  ...registry,
  readModels: {
    customerDirectory: {
      ...registry.readModels.customerDirectory,
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
              if (email === null) return;
              const handle = email.replace(/[@.]/g, "_").toUpperCase();
              await table.upsert({
                customerId: event.aggregateId,
                email: handle,
                greeting: `Hi ${handle}`,
              });
            },
          },
        },
        bounda: leaky.readModels.customerDirectory.projections.bounda,
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
      const mail = telemetry.spans.findIndex(({ name }) => name === "mail") + 1;
      expect(error).toMatchObject({
        found: [{ store: "spans", row: `span ${mail} ("mail")`, field: "attributes.to" }],
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

  it("looks for what a read model derived and kept in a field it marks, wherever it keeps its rows", async () => {
    for (const config of [{}, { readModels: { customerDirectory: memory() } }]) {
      const { app } = await createTestApp({ registry: deriving, config });
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      await app.forget("c-1");
      await app.runUntilIdle();
      const error = await rejection(expectForgotten(app, "c-1"));
      expect((error as NotForgottenError).found).toEqual([
        {
          value: "ANA_EXAMPLE_COM",
          store: "bounda_rm_customer_directory",
          row: "customerId=c-1",
          field: "greeting",
        },
      ]);
      await app.stop();
    }
  });

  it("searches an adapter the storage shares with its read models once", async () => {
    const adapter = memory();
    const { app } = await createTestApp({
      registry: leaky,
      adapter,
      config: { readModels: { customerDirectory: adapter } },
    });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect((error as NotForgottenError).found).toHaveLength(1);
    await app.stop();
  });

  it("leaves out the text of errors a test app logs only because it is a test app, unless the test chose it", async () => {
    const refusing = {
      ...chatty,
      aggregates: {
        customer: {
          ...chatty.aggregates.customer,
          ports: {
            mailer: {
              refusing: {
                create: (): Mailer => ({
                  welcome: async (email) => {
                    throw new Error(`no mailbox for ${email}`);
                  },
                }),
              },
            },
          },
        },
      },
    } as const satisfies Registry;
    const run = async (config: { runtime?: { telemetry?: { errorText: "include" } } }) => {
      const telemetry = recordTelemetry();
      try {
        const { app } = await createTestApp({
          registry: refusing,
          ports: { customer: { mailer: "refusing" } },
          config: {
            ...config,
            runtime: { ...config.runtime, policies: { retry: { strategy: "none" } } },
          },
        });
        await app.commands.registerCustomer(ana);
        await app.runUntilIdle();
        await app.forget("c-1");
        await app.runUntilIdle();
        const outcome = await expectForgotten(app, "c-1", { telemetry }).catch(
          (error: unknown) => error as NotForgottenError,
        );
        await app.stop();
        return outcome;
      } finally {
        telemetry.stop();
      }
    };
    expect(await run({})).toBeUndefined();
    const chosen = await run({ runtime: { telemetry: { errorText: "include" } } });
    expect(chosen).toBeInstanceOf(NotForgottenError);
    const where = (chosen as NotForgottenError).found.map(
      ({ store, field }) => `${store} ${field}`,
    );
    expect(where).toEqual(
      expect.arrayContaining([
        "logs fields.errorMessage",
        "logs fields.errorStack",
        "spans status.message",
        "span events attributes.exception.message",
        "span events attributes.exception.stacktrace",
      ]),
    );
  });

  it("refuses anything that is neither a test app nor an adapter", async () => {
    const error = await rejection(expectForgotten({ forget: async () => ({}) } as never, "c-1"));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "expectForgotten takes the app createTestApp returned, or an adapter: for an app built otherwise, pass its storage adapter with the values to look for",
    );
  });

  it("says, in one message, each place a value is and what to do about each kind", async () => {
    const { app } = await createTestApp({ registry: leaky });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(((await rejection(expectForgotten(app, "c-1"))) as Error).message).toBe(
      [
        'Person "c-1" was not forgotten everywhere: 1 place still holds a value of theirs in the clear.',
        '  - "ana@example.com" in bounda_rm_customer_directory, customerId=c-1, greeting',
        "What to do:",
        "  - A read model kept the value: project PersonalDataForgotten in it and delete the row or clear the field, and mark the field .personal() so its export and the access log see it.",
      ].join("\n"),
    );
    const two = await rejection(
      expectForgotten(app, "c-1", { places: { logs: "ana@example.com" } }),
    );
    expect((two as Error).message).toContain(": 2 places still hold a value");
  });

  it("gives each store its own advice, and a place of the test's none of theirs", async () => {
    const adviceFor = async (store: InspectedStore | null, places = {}): Promise<string> => {
      const adapter = {
        ...memory(),
        inspect: async (): Promise<readonly InspectedTable[]> => [
          { name: "t", store, key: [], opaque: [], rows: [{ v: "secret-value" }] },
        ],
      };
      const error = await rejection(
        expectForgotten(adapter, "c-1", { values: ["secret-value"], places }),
      );
      return (error as Error).message.split("What to do:\n")[1] ?? "";
    };
    const otherwise =
      "  - Find where the value is written in the clear and mark the field it comes from, or remove it when the person is forgotten.";
    expect(await adviceFor("readModel")).toContain("A read model kept the value");
    expect(await adviceFor("events")).toContain("An event holds the value");
    expect(await adviceFor("scheduledCommands")).toContain("A stored command holds");
    expect(await adviceFor("deadLetters")).toContain("A dead letter holds the value");
    expect(await adviceFor("idempotencyKeys")).toContain("A remembered answer quotes");
    expect(await adviceFor("snapshots")).toContain("A snapshot holds the value");
    for (const store of ["persons", "checkpoints", "forgetLedger", null] as const) {
      expect(await adviceFor(store), String(store)).toBe(otherwise);
    }
    expect(await adviceFor("events", { logs: "secret-value", "span events": "secret-value" })).toBe(
      "  - An event holds the value in a field left unmarked: mark it personal() in the event's payload, or the process state's.\n" +
        otherwise,
    );
  });

  it("refuses to search once the app stopped, or an adapter that holds no table of Bounda's", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.forget("c-1");
    await app.stop();
    expect(((await rejection(expectForgotten(app, "c-1"))) as Error).message).toContain(
      "call it before app.stop()",
    );
    const empty = { ...memory(), inspect: async () => [] };
    expect(
      ((await rejection(expectForgotten(empty, "c-1", { values: ["x"] }))) as Error).message,
    ).toContain("found no table to search");
  });

  it("searches as the app a client bound to an actor came from", async () => {
    const { app } = await createTestApp({ registry: leaky });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const support = app.as("support-1");
    await support.forget("c-1");
    await app.runUntilIdle();
    expect(await rejection(expectForgotten(support, "c-1"))).toBeInstanceOf(NotForgottenError);
    await app.stop();
  });

  it("refuses to record the telemetry while another tracer provider is registered", () => {
    const first = recordTelemetry();
    try {
      expect(() => recordTelemetry()).toThrow("another one is registered globally");
    } finally {
      first.stop();
    }
    recordTelemetry().stop();
  });

  it("names a row by every column of its key, by its place without one, and compares key material whole", async () => {
    const tables: readonly InspectedTable[] = [
      {
        name: "keyed",
        store: null,
        key: ["a", "b"],
        opaque: [],
        rows: [{ a: 1, b: "x", note: "to Ana", lines: [{ notes: ["Ana"] }] }],
      },
      {
        name: "loose",
        store: null,
        key: [],
        opaque: ["secret"],
        rows: [{ secret: "x" }, { secret: "+Ana+" }, { secret: "ana", note: "Ana" }],
      },
    ];
    const adapter = { ...memory(), inspect: async () => tables };
    const error = await rejection(expectForgotten(adapter, "c-1", { values: ["Ana"] }));
    expect((error as NotForgottenError).found).toEqual([
      { value: "Ana", store: "keyed", row: "a=1, b=x", field: "note" },
      { value: "Ana", store: "keyed", row: "a=1, b=x", field: "lines[0].notes[0]" },
      { value: "Ana", store: "loose", row: "row 3", field: "secret" },
      { value: "Ana", store: "loose", row: "row 3", field: "note" },
    ]);
  });

  it("looks for every value an export opened, from each of its parts", async () => {
    const before: PersonalDataExport = {
      personId: "c-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      events: [{ data: { email: "event-value" } }],
      scheduledCommands: [{ data: { email: "command-value" } }],
      deadLetters: [{ data: { email: "letter-value" } }],
      readModels: { directory: [{ key: "c-1", data: { email: "row-value" } }] },
    } as unknown as PersonalDataExport;
    const adapter = {
      ...memory(),
      inspect: async (): Promise<readonly InspectedTable[]> => [
        { name: "t", store: null, key: [], opaque: [], rows: [] },
      ],
    };
    const error = await rejection(
      expectForgotten(adapter, "c-1", {
        before,
        places: { found: "event-value command-value letter-value row-value" },
      }),
    );
    expect((error as NotForgottenError).found.map(({ value, field }) => [value, field])).toEqual([
      ["event-value", "value"],
      ["command-value", "value"],
      ["letter-value", "value"],
      ["row-value", "value"],
    ]);
  });

  it("reads a forget ledger past its first page", async () => {
    const kept = await memory().createForgetLedger({ tenant: undefined });
    await kept.append(
      Array.from({ length: 1_200 }, (_, index) => ({
        personId: `p-${index}`,
        eventId: `ledger-event-${String(index).padStart(4, "0")}`,
        forgottenAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
      })),
    );
    const { app } = await createTestApp({
      registry,
      config: {
        runtime: {
          personalData: { forgetLedger: { store: defineForgetLedger(async () => kept) } },
        },
      },
    });
    await app.commands.registerCustomer(ana);
    await app.forget("c-1");
    const error = await rejection(expectForgotten(app, "c-1", { values: ["ledger-event-1100"] }));
    expect((error as NotForgottenError).found).toEqual([
      {
        value: "ledger-event-1100",
        store: "forget ledger",
        row: "eventId=ledger-event-1100",
        field: "eventId",
      },
    ]);
    await app.stop();
  });

  it("looks for the person's key among everyone's, not another's", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer({ ...ana, customerId: "c-0", email: "zed@example.com" });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    expect(((await rejection(expectForgotten(app, "c-1"))) as Error).message).toContain(
      '"c-1" still holds a key',
    );
    await app.stop();
  });

  it("names span events and numbers spans and log entries from one", async () => {
    const telemetry = recordTelemetry();
    try {
      const { app } = await createTestApp({
        registry: chatty,
        ports: { customer: { mailer: "logging" } },
      });
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      await app.forget("c-1");
      await app.runUntilIdle();
      trace.getTracer("test").startSpan("mail").addEvent("sent", { to: "ana@example.com" }).end();
      const found = (
        (await rejection(expectForgotten(app, "c-1", { telemetry }))) as NotForgottenError
      ).found;
      const span = telemetry.spans.findIndex(({ name }) => name === "mail") + 1;
      const event = telemetry.spanEvents.findIndex(({ name }) => name === "sent") + 1;
      expect(found).toEqual(
        expect.arrayContaining([
          {
            value: "ana@example.com",
            store: "span events",
            row: `event ${event} ("sent" of "mail")`,
            field: "attributes.to",
          },
          expect.objectContaining({
            store: "logs",
            row: expect.stringMatching(/^entry [1-9]\d* \(info "welcome sent to/),
          }),
        ]),
      );
      expect(span).toBeGreaterThan(0);
      const message = ((await rejection(expectForgotten(app, "c-1", { telemetry }))) as Error)
        .message;
      expect(message).toContain("A log entry quotes the value");
      expect(message).toContain("A span carries the value");
      await app.stop();
    } finally {
      telemetry.stop();
    }
  });

  it("refuses a value sealed under a key the test app never held, which is a bug", async () => {
    const adapter = memory();
    const witness = testWitnessOf(adapter);
    const storage = await witness.storage(adapter).createStorage();
    await storage.scheduler.schedule({
      dedupeKey: "command:c1",
      command: {
        type: "RemindCustomer",
        aggregateType: "customer",
        aggregateId: "c-1",
        payload: { email: { $personal: { person: "c-1", key: "unseen", iv: "iv", data: "data" } } },
      } as never,
      executeAt: new Date("2026-01-01T00:00:00.000Z"),
      context: { correlationId: "c", causationId: "c" } as never,
    });
    const app = { forget: async () => ({}) } as never;
    registerTestApp(app, {
      witness,
      adapters: [adapter],
      ledgers: [],
      stopped: () => false,
      errorTextChosen: false,
    });
    expect(((await rejection(expectForgotten(app, "c-1"))) as Error).message).toBe(
      'expectForgotten saw a value of "c-1" sealed under a key the test app never held; report this as a bug in Bounda',
    );
  });
});
