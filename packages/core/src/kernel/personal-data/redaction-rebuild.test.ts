import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
import type { createFixedClock } from "../../contracts/clock.ts";
import type { LogFields, Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RedactedFields } from "../../modules/redaction.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectRedacted, NotRedactedError } from "../../testing/index.ts";

type Events = Record<string, (payload: unknown) => unknown>;

// A copy of the email that quotes none of it, as a hash or a reformatted value is.
const reversed = (email: string): string => [...email].reverse().join("");

const domainOf = (email: string): string => email.slice(email.indexOf("@") + 1);

// Holds the next projection of a registration into the mailing list until it is opened.
let gate: { readonly reached: () => void; readonly opened: Promise<void> } | undefined;

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()), plan: z.string() }),
          evolve: ({ state }: { state: object }) => state,
        },
        noteAdded: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ noteId: z.string(), text: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string(), plan: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; plan: string } };
              events: Events;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
        addNote: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), noteId: z.string(), text: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { noteId: string; text: string } };
              events: Events;
            }) => [events.noteAdded?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    // Kept on a database of its own.
    mailing: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          handle: f.string().optional().personal(),
          plan: f.string().optional().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null; plan: string } };
              table: Table<{ customerId: string; handle: string | null; plan: string }>;
            }) => {
              const held = gate;
              gate = undefined;
              held?.reached();
              await held?.opened;
              await table.upsert({
                customerId: event.aggregateId,
                handle: event.payload.email === null ? null : reversed(event.payload.email),
                plan: event.payload.plan,
              });
            },
          },
        },
      },
      queries: {
        mailingOf: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { customerId: string } };
            table: Table<{ customerId: string }>;
          }) => table.findOne({ customerId: query.payload.customerId }),
        },
      },
    },
    // Marks nothing personal, though what it keeps comes from a personal field.
    domains: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          domain: f.string().primaryKey(),
          customers: f.number(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: { payload: { email: string | null } };
              table: Table<{ domain: string; customers: number }>;
            }) => {
              if (event.payload.email === null) return;
              const domain = domainOf(event.payload.email);
              const row = await table.findOne({ domain });
              await table.upsert({ domain, customers: (row?.customers ?? 0) + 1 });
            },
          },
        },
      },
      queries: {
        allDomains: {
          handler: ({ table }: { table: Table<{ domain: string }> }) =>
            table.findMany({ orderBy: { field: "domain", direction: "asc" } }),
        },
      },
    },
    // Projects no event a redaction of the email reaches.
    notes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          noteId: f.string().primaryKey(),
          customerId: f.string().index().person(),
          text: f.string().personal(),
        }),
      },
      projections: {
        customer: {
          noteAdded: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { noteId: string; text: string | null } };
              table: Table<{ noteId: string; customerId: string; text: string | null }>;
            }) =>
              table.upsert({
                noteId: event.payload.noteId,
                customerId: event.aggregateId,
                text: event.payload.text,
              }),
          },
        },
      },
      queries: {},
    },
  },
} as unknown as Registry;

const adapters: readonly (readonly [string, () => Adapter])[] = [
  ["in memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  gate = undefined;
  for (const stop of stops.splice(0)) await stop();
});

interface Logged {
  readonly level: keyof Logger;
  readonly message: string;
  readonly fields: LogFields | undefined;
}

const setUp = async (
  adapter: Adapter,
  { batchSize, mailing = memory() }: { batchSize?: number; mailing?: Adapter } = {},
) => {
  const logged: Logged[] = [];
  const log =
    (level: keyof Logger) =>
    (message: string, fields?: LogFields): void => {
      logged.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
  let clock: ReturnType<typeof createFixedClock> | undefined;
  const start = async () => {
    const { app, clock: started } = await createTestApp({
      registry,
      adapter,
      logger,
      config: {
        readModels: { mailing },
        ...(batchSize === undefined ? {} : { runtime: { dispatcher: { batchSize } } }),
      },
    });
    stops.push(() => app.stop());
    clock ??= started;
    return app;
  };
  const app = await start();
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown) => Promise<unknown>
  >;
  const queries = app.queries as unknown as Record<string, (payload?: unknown) => Promise<unknown>>;
  const registered = async (customerId: string, email: string) => {
    await commands.registerCustomer?.({ customerId, email, plan: "pro" });
    await app.runUntilIdle();
  };
  // The person's events whose fields hold the value, as their export lists them.
  const holding = async (personId: string, value: unknown): Promise<RedactedFields[]> =>
    (await app.exportPersonalData(personId)).events.flatMap((event) => {
      const fields = Object.entries(event.data)
        .filter(([, held]) => held === value)
        .map(([field]) => field);
      return fields.length === 0
        ? []
        : [
            {
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              type: event.type,
              id: event.id,
              fields,
            },
          ];
    });
  const rebuilt = (readModel: string) =>
    logged.filter(
      ({ message, fields }) =>
        (message === "read model rebuilt" || message === "read model rebuild paused") &&
        fields?.readModel === readModel,
    );
  // The worker looks again a poll later at what waited.
  const later = () => clock?.advance(60_000);
  return { app, start, commands, queries, registered, holding, rebuilt, logged, later };
};

describe.each(adapters)("redact, rebuilding what was derived, %s", (_, adapterOf) => {
  it("hides the person's values in a read model on another database until its rebuild takes the table's place", async () => {
    const { app, queries, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    expect(await queries.mailingOf?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      handle: reversed("ana@old.example"),
      plan: "pro",
    });
    const redacted = await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.catchUpReadModels({ through: redacted });
    expect(await queries.mailingOf?.({ customerId: "ana" })).toEqual({ customerId: "ana" });
    expect(await queries.mailingOf?.({ customerId: "bo" })).toEqual({
      customerId: "bo",
      handle: reversed("bo@example.com"),
      plan: "pro",
    });
    await app.runUntilIdle();
    expect(await queries.mailingOf?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      plan: "pro",
    });
    await expectRedacted(app, "ana", { values: [reversed("ana@old.example")] });
  });

  it("rebuilds a read model that marks nothing personal, so what it derived goes too", async () => {
    const { app, queries, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    expect(await queries.allDomains?.()).toEqual([{ domain: "example.com", customers: 1 }]);
  });

  it("leaves a read model that projects no event the redaction reached as it is", async () => {
    const { app, commands, registered, holding, rebuilt } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await commands.addNote?.({ customerId: "ana", noteId: "n-1", text: "likes tea" });
    await app.runUntilIdle();
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    expect(rebuilt("notes")).toEqual([]);
    expect(rebuilt("mailing")).not.toEqual([]);
  });

  it("rejects in expectRedacted until the worker has rebuilt what projects the redacted events", async () => {
    const { app, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    const redacted = await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.catchUpReadModels({ through: redacted });
    const error = await expectRedacted(app, "ana").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotRedactedError);
    expect((error as NotRedactedError).found).toContainEqual({
      value: "a copy derived from a redacted value",
      store: "readModel",
      row: "projecting customer.CustomerRegistered",
      field: `not rebuilt since redaction:${redacted.eventIds[0]}`,
    });
    expect((error as NotRedactedError).message).toContain("await app.runUntilIdle()");
    await app.runUntilIdle();
    await expectRedacted(app, "ana");
  });

  it("rebuilds a slice a pass, resuming a rebuild that started after the redaction", async () => {
    const { app, registered, holding, rebuilt } = await setUp(adapterOf(), { batchSize: 1 });
    for (let index = 0; index < 25; index += 1) {
      await registered(`c-${index}`, `c-${index}@old.example`);
    }
    const redacted = await app.redact("c-0", { events: await holding("c-0", "c-0@old.example") });
    const operator = await app.rebuildReadModel("mailing", { maxEvents: 2 });
    expect(operator).toMatchObject({ done: false });
    await app.runUntilIdle();
    const slices = rebuilt("mailing");
    expect(slices.length).toBeGreaterThan(2);
    expect(slices.at(-1)?.message).toBe("read model rebuilt");
    // Every event read once across the slices: none started over.
    const events = slices.reduce((sum, { fields }) => sum + Number(fields?.events ?? 0), 0);
    expect(events).toBe((await app.events.read({ limit: 1_000 })).length);
    // It had not reached the redaction yet, and went on from where it stood.
    expect(operator.position).toBeLessThan(redacted.position);
  });

  it("hides the person in a rebuild that began before the redaction, until the next one", async () => {
    const { app, queries, registered, holding } = await setUp(adapterOf(), { batchSize: 1 });
    await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    expect(await app.rebuildReadModel("mailing", { maxEvents: 1 })).toMatchObject({ done: false });
    const redacted = await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.catchUpReadModels({ through: redacted });
    // The shadow derived the handle from the email before the redaction.
    expect(await app.rebuildReadModel("mailing")).toMatchObject({ done: true });
    expect(await queries.mailingOf?.({ customerId: "ana" })).toEqual({ customerId: "ana" });
    await app.runUntilIdle();
    expect(await queries.mailingOf?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      plan: "pro",
    });
    expect(await queries.mailingOf?.({ customerId: "bo" })).toEqual({
      customerId: "bo",
      handle: reversed("bo@example.com"),
      plan: "pro",
    });
  });

  it("lets a rebuild run by hand take over the worker's, and settles once it has", async () => {
    const { app, registered, holding, rebuilt, logged } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    let reached = (): void => undefined;
    let open = (): void => undefined;
    const projecting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    gate = {
      reached,
      opened: new Promise<void>((resolve) => {
        open = resolve;
      }),
    };
    const working = app.runUntilIdle();
    await projecting;
    const byHand = app.rebuildReadModel("mailing");
    open();
    expect(await byHand).toMatchObject({ done: true });
    await working;
    await app.runUntilIdle();
    expect(logged.filter(({ level }) => level === "error")).toEqual([]);
    expect(
      rebuilt("mailing").filter(({ message }) => message === "read model rebuilt"),
    ).toHaveLength(1);
    await expectRedacted(app, "ana", { values: [reversed("ana@old.example")] });
  });

  it("lets two instances rebuild the same read model, each taking over from the other quietly", async () => {
    const adapter = adapterOf();
    const { app, start, registered, holding, rebuilt, logged, later } = await setUp(adapter, {
      batchSize: 1,
    });
    for (const customerId of ["ana", "bo", "cy", "di"]) {
      await registered(customerId, `${customerId}@old.example`);
    }
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.redact("bo", { events: await holding("bo", "bo@old.example") });
    const other = await start();
    await Promise.all([app.runUntilIdle(), other.runUntilIdle()]);
    later();
    await app.runUntilIdle();
    expect(logged.filter(({ message }) => message.includes("could not be settled"))).toEqual([]);
    expect(rebuilt("mailing").at(-1)?.message).toBe("read model rebuilt");
    await expectRedacted(app, "ana", { values: [reversed("ana@old.example")] });
    await expectRedacted(app, "bo", { values: [reversed("bo@old.example")] });
  });

  it("goes on from where it stood after a restart", async () => {
    const adapter = adapterOf();
    const { app, start, registered, holding, rebuilt } = await setUp(adapter, { batchSize: 1 });
    for (const customerId of ["ana", "bo", "cy"]) {
      await registered(customerId, `${customerId}@old.example`);
    }
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.stop();
    const again = await start();
    await again.runUntilIdle();
    expect(rebuilt("mailing").at(-1)?.message).toBe("read model rebuilt");
    expect(
      await (
        again.queries as unknown as Record<string, (p: unknown) => Promise<unknown>>
      ).mailingOf?.({ customerId: "ana" }),
    ).toEqual({ customerId: "ana", plan: "pro" });
    await expectRedacted(again, "ana", { values: [reversed("ana@old.example")] });
  });
});
