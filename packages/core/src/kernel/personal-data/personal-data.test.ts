import { describe, expect, it } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import { ConfigurationError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";
import { createApp } from "../app.ts";
import { isSealed } from "./crypto.ts";

interface CustomerState {
  readonly email: string | null;
  readonly name: string;
}

interface Row {
  readonly customerId: string;
  readonly email?: string;
  readonly name: string;
}

const erased: string[] = [];

const registry = {
  aggregates: {
    customer: {
      state: { initialState: { email: null, name: "" } satisfies CustomerState },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), name: z.string() }),
          evolve: ({ event }: { event: { payload: { email: string | null; name: string } } }) => ({
            email: event.payload.email,
            name: event.payload.name,
          }),
        },
        customerGreeted: {
          payload: ({ z }: EventPayloadArgs) => z.object({ to: z.string().nullable() }),
          evolve: ({ state }: { state: CustomerState }) => state,
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
        greetCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({
              state,
              events,
            }: {
              state: CustomerState;
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerGreeted?.({ to: state.email })],
          },
        },
      },
      policies: {
        boundaEraseOnPersonalDataForgotten: {
          module: {
            handler: async ({ event }: { event: PersonalDataForgottenEvent }) => {
              erased.push(event.payload.personId);
            },
          },
          source: "bounda",
        },
      },
      processes: {},
    },
  },
  readModels: {
    customerDirectory: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey(),
          email: f.string().optional(),
          name: f.string(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null; name: string }>;
              table: Table<Row>;
            }) => {
              await table.upsert({
                customerId: event.aggregateId,
                name: event.payload.name,
                ...(event.payload.email === null ? {} : { email: event.payload.email }),
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
      queries: {
        getCustomer: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<Row>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: Row | null }) => repositoryData,
        },
      },
    },
  },
} as const satisfies Registry;

const ana = { customerId: "c-1", email: "ana@example.com", name: "Ana" };

describe("personal data in an app", () => {
  it("stores personal fields sealed, projects them in the clear, and forgets a person end to end", async () => {
    erased.length = 0;
    const { app } = await createTestApp({ registry });
    const registered = await app.commands.registerCustomer(ana);
    await app.catchUpReadModels({ through: registered });
    expect(await app.queries.getCustomer({ customerId: "c-1" })).toEqual({
      customerId: "c-1",
      email: "ana@example.com",
      name: "Ana",
    });
    const [raw] = await app.events.read();
    expect(isSealed((raw?.payload as { email: unknown } | undefined)?.email)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain("ana@example.com");

    const forgotten = await app.forget("c-1");
    expect(forgotten).toMatchObject({
      aggregateType: "bounda",
      aggregateId: "c-1",
      eventTypes: ["PersonalDataForgotten"],
      position: 2,
    });
    await app.catchUpReadModels({ through: forgotten });
    expect(await app.queries.getCustomer({ customerId: "c-1" })).toBeNull();
    expect(JSON.stringify(await app.events.read())).not.toContain("ana@example.com");

    const greeted = await app.commands.greetCustomer({ customerId: "c-1" });
    expect(greeted.eventTypes).toEqual(["CustomerGreeted"]);
    const [, , greeting] = await app.events.read();
    expect(greeting?.payload).toEqual({ to: null });

    expect((await app.runUntilIdle()).idle).toBe(true);
    expect(erased).toEqual(["c-1"]);
    await app.stop();
  });

  it("rebuilds a read model from the sealed stream, reading what is still readable", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.commands.registerCustomer({ customerId: "c-2", email: "bo@example.com", name: "Bo" });
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(await app.rebuildReadModel("customerDirectory")).toMatchObject({ done: true });
    expect(await app.queries.getCustomer({ customerId: "c-1" })).toBeNull();
    expect(await app.queries.getCustomer({ customerId: "c-2" })).toEqual({
      customerId: "c-2",
      email: "bo@example.com",
      name: "Bo",
    });
    await app.stop();
  });

  it("keeps the keys of other people and takes a new one for someone registered again", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.commands.registerCustomer({ customerId: "c-2", email: "bo@example.com", name: "Bo" });
    await app.forget("c-1");
    await app.commands.greetCustomer({ customerId: "c-2" });
    await app.commands.registerCustomer({ ...ana, email: "ana@again.example" });
    await app.commands.greetCustomer({ customerId: "c-1" });
    const events = await app.events.read();
    expect(events.map((event) => event.type)).toEqual([
      "CustomerRegistered",
      "CustomerRegistered",
      "PersonalDataForgotten",
      "CustomerGreeted",
      "CustomerRegistered",
      "CustomerGreeted",
    ]);
    expect(events[3]?.payload).toEqual({ to: "bo@example.com" });
    expect(events[5]?.payload).toEqual({ to: "ana@again.example" });
    await app.catchUpReadModels();
    expect(await app.queries.getCustomer({ customerId: "c-1" })).toEqual({
      customerId: "c-1",
      email: "ana@again.example",
      name: "Ana",
    });
    await app.stop();
  });

  it("seals what a command dispatched with an idempotency key stores, and replays its answer", async () => {
    const { app } = await createTestApp({ registry });
    const first = await app.commands.registerCustomer(ana, { idempotencyKey: "signup-1" });
    const again = await app.commands.registerCustomer(ana, { idempotencyKey: "signup-1" });
    expect(again).toEqual(first);
    const events = await app.events.read();
    expect(events).toHaveLength(1);
    expect(isSealed((events[0]?.payload as { email: unknown } | undefined)?.email)).toBe(true);
    await app.stop();
  });

  it("forgets a person's snapshots too, so their aggregate loads with the fields forgotten", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage({ logger: silentLogger });
    const { app } = await createTestApp({
      registry: {
        ...registry,
        aggregates: {
          customer: { ...registry.aggregates.customer, stateFingerprint: "fp" },
        },
      },
      config: { runtime: { overrides: { customer: { snapshot: { every: 1 } } } } },
      adapter,
    });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const stream = { aggregateType: "customer", aggregateId: "c-1" };
    expect(await storage.snapshotStore.get(stream)).toMatchObject({ version: 1, persons: ["c-1"] });
    expect((await storage.snapshotStore.get(stream))?.state).toContain("ana@example.com");

    await app.forget("c-1");
    expect(await storage.snapshotStore.get(stream)).toBeNull();
    const greeted = await app.commands.greetCustomer({ customerId: "c-1" });
    const [greeting] = await app.events.read({ after: greeted.position - 1 });
    expect(greeting?.payload).toEqual({ to: null });
    await app.runUntilIdle();
    expect(await storage.snapshotStore.get(stream)).toMatchObject({ version: 2, persons: [] });
    expect((await storage.snapshotStore.get(stream))?.state).not.toContain("ana@example.com");
    await app.stop();
  });

  it("refuses to forget nobody", async () => {
    const { app } = await createTestApp({ registry });
    await expect(app.forget("")).rejects.toBeInstanceOf(ValidationError);
    await app.stop();
  });

  it("refuses a policy on an event the runtime does not emit, and an aggregate named bounda", async () => {
    await expect(
      createApp({
        registry: {
          ...registry,
          aggregates: {
            ...registry.aggregates,
            bounda: { events: {}, commands: {}, policies: {}, processes: {} },
          },
        },
        config: { storage: memory() },
        logger: silentLogger,
      }),
    ).rejects.toThrow(
      new ConfigurationError(
        [
          "Invalid registry:",
          '  aggregates.bounda: "bounda" is the runtime\'s own aggregate; give yours another name',
        ].join("\n"),
      ),
    );
    await expect(
      createApp({
        registry: {
          ...registry,
          aggregates: {
            customer: {
              ...registry.aggregates.customer,
              policies: {
                boundaNotifyOnPersonalDataLost: {
                  module: { on: "PersonalDataLost", handler: async () => undefined },
                  source: "bounda",
                },
              },
            },
          },
        },
        config: { storage: memory() },
        logger: silentLogger,
      }),
    ).rejects.toThrow(
      new ConfigurationError(
        'aggregates.customer.policies.boundaNotifyOnPersonalDataLost: "PersonalDataLost" is not an event of the aggregate "bounda"',
      ),
    );
  });
});
