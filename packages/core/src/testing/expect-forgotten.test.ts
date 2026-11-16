import { describe, expect, it } from "vitest";
import type { Adapter } from "../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../adapter/sqlite/node-sqlite.ts";
import type { InspectedStore, InspectedTable } from "../adapter/storage/inspection.ts";
import type { Table } from "../adapter/storage/table.ts";
import type { Config } from "../config/types.ts";
import type { StoredEvent } from "../contracts/event.ts";
import type { LogFields } from "../contracts/logger.ts";
import { silentLogger } from "../contracts/logger.ts";
import { createApp } from "../kernel/app.ts";
import type { PersonalDataExport } from "../kernel/personal-data/export.ts";
import { defineForgetLedger } from "../kernel/personal-data/forget-ledger.ts";
import { installFakeTelemetry } from "../kernel/telemetry-fake.ts";
import type { Witness } from "../kernel/witness.ts";
import { witnessHooksOf } from "../kernel/witness.ts";
import { memory } from "../memory/index.ts";
import type { PersonalDataForgottenEvent } from "../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../modules/payload.ts";
import type { CreateArgs } from "../modules/port.ts";
import type { Registry } from "../modules/registry.ts";
import type { FieldsArgs } from "../modules/view.ts";
import { expectForgotten, expectTenantForgotten, NotForgottenError } from "./expect-forgotten.ts";
import { expectRedacted, type NotRedactedError } from "./expect-redacted.ts";
import { createTestApp } from "./index.ts";
import { createWitness, testWitnessOf } from "./witness.ts";

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
          email: f.string().optional().personal({ clear: true }),
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

// A mailer that refuses every address, quoting it in its error.
const refusingRegistry = {
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

// Keeps a handle made from the email in a field it marks, and in the greeting it keeps.
const deriving = {
  ...registry,
  readModels: {
    customerDirectory: {
      ...registry.readModels.customerDirectory,
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal({ clear: true }),
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

  it("finds a value in a span the app started, with no tracer provider registered", async () => {
    const { app } = await createTestApp({ registry, adapter: adapterOf() });
    await app.as("ana@example.com").commands.registerCustomer(ana);
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = await rejection(expectForgotten(app, "c-1"));
    expect((error as NotForgottenError).found).toContainEqual({
      value: "ana@example.com",
      store: "spans",
      row: 'span 1 ("bounda.command RegisterCustomer")',
      field: "attributes.bounda.actor",
    });
    expect((error as Error).message).toContain("A span carries the value");
    await app.stop();
  });

  it("records an app's spans beside the tracer provider registered, which still gets each, and no other app's", async () => {
    const telemetry = installFakeTelemetry();
    try {
      const traced = await createTestApp({ registry });
      const quiet = await createTestApp({ registry });
      await traced.app.as("ana@example.com").commands.registerCustomer(ana);
      await quiet.app.commands.registerCustomer(ana);
      for (const { app } of [traced, quiet]) {
        await app.forget("c-1");
        await app.runUntilIdle();
      }
      await expectForgotten(quiet.app, "c-1");
      expect(
        ((await rejection(expectForgotten(traced.app, "c-1"))) as NotForgottenError).found,
      ).toContainEqual(
        expect.objectContaining({ store: "spans", field: "attributes.bounda.actor" }),
      );
      expect(telemetry.spans).toContainEqual(
        expect.objectContaining({
          name: "bounda.command RegisterCustomer",
          attributes: expect.objectContaining({ "bounda.actor": "ana@example.com" }),
          ended: true,
        }),
      );
      await traced.app.stop();
      await quiet.app.stop();
    } finally {
      telemetry.restore();
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
    const run = async (config: { runtime?: { telemetry?: { errorText: "include" } } }) => {
      const { app } = await createTestApp({
        registry: refusingRegistry,
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
      const outcome = await expectForgotten(app, "c-1").catch(
        (error: unknown) => error as NotForgottenError,
      );
      await app.stop();
      return outcome;
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

  it("keeps searching what is not an error's text in a span whose error's text it leaves out", async () => {
    const { app } = await createTestApp({
      registry: refusingRegistry,
      ports: { customer: { mailer: "refusing" } },
      config: { runtime: { policies: { retry: { strategy: "none" } } } },
    });
    await app.as("ana@example.com").commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const found = ((await rejection(expectForgotten(app, "c-1"))) as NotForgottenError).found;
    const failed = found.filter(({ row }) => row.includes("bounda.policy"));
    expect(failed).toEqual([expect.objectContaining({ field: "attributes.bounda.actor" })]);
    expect(found.map(({ field }) => field)).not.toContain("status.message");
    await app.stop();
  });

  it("refuses anything that is neither a test app nor an adapter", async () => {
    const error = await rejection(expectForgotten({ forget: async () => ({}) } as never, "c-1"));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toBe(
      "expectForgotten takes an app createTestApp returned or one given a witness, a client of one, a witness, a Durable Object of a class witnessObjects watches, or an adapter: for an app built without a witness, pass its storage adapter with the values to look for",
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
        "  - A read model kept the value: mark the field .personal(), which seals it under the person's key; for a field kept in the clear with .personal({ clear: true }), project PersonalDataForgotten and delete the row or clear the field.",
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
    expect(await adviceFor("idempotencyKeys")).toContain("A remembered answer holds");
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
        categories: null,
        reason: "requested" as const,
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
    const { app } = await createTestApp({
      registry: refusingRegistry,
      ports: { customer: { mailer: "refusing" } },
      config: {
        runtime: { telemetry: { errorText: "include" }, policies: { retry: { strategy: "none" } } },
      },
    });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = (await rejection(expectForgotten(app, "c-1"))) as NotForgottenError;
    expect(error.found).toEqual(
      expect.arrayContaining([
        {
          value: "ana@example.com",
          store: "span events",
          row: expect.stringMatching(/^event 1 \("exception" of "bounda\.policy /),
          field: "attributes.exception.message",
        },
        expect.objectContaining({
          store: "spans",
          row: expect.stringMatching(/^span [1-9]\d* \("bounda\.policy /),
          field: "status.message",
        }),
        expect.objectContaining({
          store: "logs",
          row: expect.stringMatching(/^entry [1-9]\d* \(/),
          field: "fields.errorMessage",
        }),
      ]),
    );
    expect(error.message).toContain("A log entry quotes the value");
    expect(error.message).toContain("A span carries the value");
    await app.stop();
  });

  it("refuses a value sealed under a key the test app never held, which is a bug", async () => {
    const adapter = memory();
    const witness = witnessHooksOf(testWitnessOf(adapter).witness).attach({
      searchErrorText: true,
    });
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
      scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
      context: { correlationId: "c", causationId: "c" } as never,
    });
    const app = { forget: async () => ({}), exportPersonalData: async () => ({}) as never };
    witness.onApp(app, [adapter]);
    expect(((await rejection(expectForgotten(app, "c-1"))) as Error).message).toBe(
      'expectForgotten saw a value of "c-1" sealed under a key the test app never held; report this as a bug in Bounda',
    );
  });
});

describe("expectForgotten given an app built with a witness", () => {
  const start = <R extends Registry>(witness: Witness, from: R, config: Partial<Config> = {}) =>
    createApp<R>({
      registry: from,
      config: {
        storage: memory(),
        ports: { customer: { mailer: "logging" } },
        ...config,
      } as Config,
      witness,
    });

  it("looks for what the app sealed with no value given, as for a test app", async () => {
    const witness = createWitness();
    const app = await start(witness, leaky, { ports: {} as never });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    const error = (await rejection(expectForgotten(app, "c-1"))) as NotForgottenError;
    expect(error.found).toEqual([
      {
        value: "ana@example.com",
        store: "bounda_rm_customer_directory",
        row: "customerId=c-1",
        field: "greeting",
      },
    ]);
    await app.stop();
  });

  it("passes once nothing of the person is left, given the app, a client of it or the witness", async () => {
    const witness = createWitness();
    const app = await start(witness, registry, { ports: {} as never });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    for (const target of [app, app.as("support-1"), witness]) {
      await expectForgotten(target, "c-1");
    }
    await app.stop();
  });

  it("searches what the app logged and traced, and what the host logged through the witness", async () => {
    const witness = createWitness();
    const app = await start(witness, chatty);
    await app.as("ana@example.com").commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.forget("c-1");
    await app.runUntilIdle();
    witness.logger(silentLogger).info("host saw c-1", { to: "ana@example.com" });
    for (const target of [app, app.as("support-1"), witness]) {
      const found = ((await rejection(expectForgotten(target, "c-1"))) as NotForgottenError).found;
      expect(found).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ store: "logs", field: "message" }),
          expect.objectContaining({ store: "logs", field: "fields.to" }),
          expect.objectContaining({ store: "spans", field: "attributes.bounda.actor" }),
        ]),
      );
    }
    await app.stop();
  });

  it("searches the text of errors the app is configured to write, which a test harness did not add", async () => {
    const run = async (errorText: "omit" | "include") => {
      const witness = createWitness();
      const app = await start(witness, refusingRegistry, {
        ports: { customer: { mailer: "refusing" } } as never,
        runtime: { telemetry: { errorText }, policies: { retry: { strategy: "none" } } },
      });
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      await app.forget("c-1");
      await app.runUntilIdle();
      const outcome = await expectForgotten(witness, "c-1").catch(
        (error: unknown) => error as NotForgottenError,
      );
      await app.stop();
      return outcome;
    };
    expect(await run("omit")).toBeUndefined();
    const included = await run("include");
    expect(included?.found.map(({ store, field }) => `${store} ${field}`)).toEqual(
      expect.arrayContaining([
        "logs fields.errorMessage",
        "spans status.message",
        "span events attributes.exception.message",
      ]),
    );
  });

  it("searches every app the witness watches that runs, and says when none does", async () => {
    const witness = createWitness();
    await expect(expectForgotten(witness, "c-1")).rejects.toThrow(
      "expectForgotten found no app the witness watched: give the witness to createApp, boot() or createBounda as witness before the app starts",
    );
    const clean = await start(witness, registry, { ports: {} as never });
    const leaking = await start(witness, leaky, { ports: {} as never });
    for (const app of [clean, leaking]) {
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      await app.forget("c-1");
      await app.runUntilIdle();
    }
    const error = (await rejection(expectForgotten(clean, "c-1"))) as NotForgottenError;
    expect(error.found).toMatchObject([
      { store: "bounda_rm_customer_directory", field: "greeting" },
    ]);
    await leaking.stop();
    await expectForgotten(clean, "c-1");
    await clean.stop();
    await expect(expectForgotten(witness, "c-1")).rejects.toThrow(
      "expectForgotten reads what the app keeps, so call it before app.stop(): an in-memory database is gone once the app stops",
    );
  });

  it("checks a tenant's forgetting through the witness, each app it watches refusing every call", async () => {
    const witness = createWitness();
    const app = await start(witness, registry, { ports: {} as never });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await expect(expectTenantForgotten(witness)).rejects.toThrow(
      "the app still serves calls: forget the tenant with forgetTenant first",
    );
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await expectTenantForgotten(witness);
    await app.stop();
  });

  it("watches an app that starts for a tenant forgotten already, and the clients it hands out", async () => {
    const witness = createWitness();
    const storage = memory();
    const first = await start(witness, registry, { storage, ports: {} as never });
    await first.commands.registerCustomer(ana);
    await first.runUntilIdle();
    await first.forgetTenant("default", { despiteLegalObligations: true });
    await first.stop();
    const again = await start(witness, registry, { storage, ports: {} as never });
    await expectTenantForgotten(again);
    await expectTenantForgotten(again.as("support-1").as("support-2"));
    await again.stop();
    await expect(expectTenantForgotten(witness)).rejects.toThrow("before app.stop()");
  });

  it("checks a redaction through the witness, finding the old value the app logged", async () => {
    const witness = createWitness();
    const app = await start(witness, chatty);
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const [registered] = (await app.exportPersonalData("c-1")).events;
    if (registered === undefined) throw new Error("no event exported");
    await app.redact("c-1", {
      events: [
        { ...registered, aggregateType: "customer", type: "CustomerRegistered", fields: ["email"] },
      ],
    } as never);
    await app.runUntilIdle();
    const error = (await rejection(expectRedacted(witness, "c-1"))) as NotRedactedError;
    expect(error.found).toMatchObject([{ value: "ana@example.com", store: "logs" }]);
    await app.stop();
  });

  it("is refused when it is not one createWitness made, and records nothing for an app given none", async () => {
    await expect(
      createApp({
        registry,
        config: { storage: memory() },
        witness: { logger: (logger) => logger, watch: () => undefined },
      }),
    ).rejects.toThrow("witness must be what createWitness() from @bounda-dev/core/testing returns");
    await expect(
      createApp({
        registry,
        config: { storage: memory() },
        witness: {
          logger: (logger) => logger,
          watch: () => undefined,
          [Symbol.for("@bounda-dev/core/witness")]: null,
        } as Witness,
      }),
    ).rejects.toThrow("witness must be what createWitness() from @bounda-dev/core/testing returns");
    const app = await createApp({ registry, config: { storage: memory() } });
    await expect(expectForgotten(app, "c-1")).rejects.toBeInstanceOf(TypeError);
    await app.stop();
  });
});

describe("expectForgotten by categories", () => {
  const categorized = {
    aggregates: {
      customer: {
        state: { initialState: {} },
        events: {
          customerBilled: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                newsletter: personal(z.email(), { category: "marketing" }),
                invoice: personal(z.string(), { category: "invoices" }),
              }),
            evolve: () => ({}),
          },
        },
        commands: {
          billCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) =>
                z.object({ customerId: z.string(), newsletter: z.string(), invoice: z.string() }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { newsletter: string; invoice: string } };
                events: Events;
              }) => [events.customerBilled?.(command.payload)],
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {},
    personalData: {
      categories: {
        marketing: { basis: "consent", retention: "730d" },
        invoices: { basis: "legal-obligation", retention: "6y" },
      },
    },
  } as unknown as Registry;

  const billed = async () => {
    const { app } = await createTestApp({ registry: categorized });
    await app.commands.billCustomer?.({
      customerId: "c-1",
      newsletter: "ana@example.com",
      invoice: "INV-2026-0001",
    });
    return app;
  };

  it("checks a withdrawn consent alone, and refuses a category the person still holds", async () => {
    const app = await billed();
    await app.forget("c-1", { categories: ["marketing"] });
    await expect(
      expectForgotten(app, "c-1", { categories: ["marketing"] }),
    ).resolves.toBeUndefined();
    await expect(
      expectForgotten(app, "c-1", {
        categories: ["marketing"],
        places: { mail: ["ana@example.com"] },
      }),
    ).rejects.toBeInstanceOf(NotForgottenError);
    await expect(expectForgotten(app, "c-1", { categories: ["invoices"] })).rejects.toThrow(
      '"c-1" still holds a key in force of "invoices": forget those categories before expectForgotten',
    );
    await app.stop();
  });

  it("leaves out what a legal obligation keeps after the person is forgotten as a whole", async () => {
    const app = await billed();
    const before = await app.exportPersonalData("c-1");
    await app.forget("c-1");
    await expect(
      expectForgotten(app, "c-1", { places: { kept: ["INV-2026-0001"] } }),
    ).resolves.toBeUndefined();
    await expect(
      expectForgotten(app, "c-1", {
        before,
        categories: ["marketing"],
        places: { kept: ["INV-2026-0001"] },
      }),
    ).resolves.toBeUndefined();
    await expect(
      expectForgotten(app, "c-1", { before, places: { kept: ["INV-2026-0001"] } }),
    ).rejects.toBeInstanceOf(NotForgottenError);
    await app.stop();
  });
});
