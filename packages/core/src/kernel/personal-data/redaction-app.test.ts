import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RedactedFields } from "../../modules/redaction.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectRedacted, NotRedactedError } from "../../testing/index.ts";

type Events = Record<string, (payload: unknown) => unknown>;

interface ContactRow {
  readonly customerId: string;
  readonly email: string | null;
  readonly greeting?: string | null;
  readonly plan?: string | null;
}

// The audit read model quotes the email in its error while it is down, as a careless projection does.
let auditDown = false;
// What the delayed policy and the upcast read of the email, in order.
const remembered: unknown[] = [];
const upcastRead: unknown[] = [];
// The contacts read model fails every event while it is down.
let contactsDown = false;

const setEmail = ({ event }: { event: { payload: { email: string | null } } }) => ({
  email: event.payload.email,
});

const registry = {
  personalData: {
    categories: { invoices: { basis: "legal-obligation", retention: "6y" } },
  },
  aggregates: {
    customer: {
      state: { initialState: { email: null } },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()), plan: z.string() }),
          evolve: setEmail,
        },
        emailCorrected: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ email: personal(z.string()) }),
          evolve: setEmail,
        },
        emailEchoed: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()).nullable() }),
          evolve: ({ state }: { state: object }) => state,
        },
        invoiceIssued: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ address: personal(z.string(), { category: "invoices" as never }) }),
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
        correctEmail: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string } };
              events: Events;
            }) => [events.emailCorrected?.({ email: command.payload.email })],
          },
        },
        echoEmail: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({ state, events }: { state: { email: string | null }; events: Events }) => [
              events.emailEchoed?.({ email: state.email }),
            ],
          },
        },
        issueInvoice: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), address: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { address: string } };
              events: Events;
            }) => [events.invoiceIssued?.({ address: command.payload.address })],
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
            }) => [
              events.noteAdded?.({ noteId: command.payload.noteId, text: command.payload.text }),
            ],
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, personal }: PayloadArgs & { personal: (schema: unknown) => never }) =>
              z.object({ customerId: z.string(), email: personal(z.string()) }),
            handler: () => [],
          },
        },
      },
      policies: {
        rememberOnCustomerRegistered: {
          module: {
            delay: "1h",
            handler: ({ event }: { event: { payload: { email: string | null } } }) => {
              remembered.push(event.payload.email);
            },
          },
        },
      },
      processes: {
        contactProcess: {
          module: {
            config: ({ events }: { events: { customer: Record<string, string> } }) => ({
              startedBy: [events.customer.CustomerRegistered],
              completedBy: [events.customer.InvoiceIssued],
            }),
            state: ({ z, personal }: EventPayloadArgs) =>
              z.object({ contact: personal(z.string()).nullable().default(null) }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: ({ event }: { event: { payload: { email: string | null } } }) => ({
                  contact: event.payload.email,
                }),
              },
            },
          },
        },
      },
    },
  },
  readModels: {
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
      queries: {
        notesOf: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { customerId: string } };
            table: Table<{ noteId: string; customerId: string; text: string | null }>;
          }) =>
            table.findMany({
              where: { customerId: query.payload.customerId },
              orderBy: { field: "noteId", direction: "asc" },
            }),
        },
      },
    },
    invoices: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          address: f
            .string()
            .optional()
            .personal({ category: "invoices" as never }),
        }),
      },
      projections: {
        customer: {
          invoiceIssued: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { address: string | null } };
              table: Table<{ customerId: string; address?: string | null }>;
            }) => table.upsert({ customerId: event.aggregateId, address: event.payload.address }),
          },
        },
      },
      queries: {},
    },
    audit: {
      view: { fields: ({ f }: FieldsArgs) => ({ customerId: f.string().primaryKey() }) },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null } };
              table: Table<{ customerId: string }>;
            }) => {
              if (auditDown) throw new Error(`cannot index ${event.payload.email ?? "nobody"}`);
              return table.upsert({ customerId: event.aggregateId });
            },
          },
        },
      },
      queries: {},
    },
    contacts: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal().unique(),
          greeting: f.string().optional().personal(),
          plan: f.string().optional().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null; plan: string } };
              table: Table<ContactRow>;
            }) => {
              if (contactsDown) throw new Error("contacts are down");
              return table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email,
                greeting: event.payload.email === null ? null : `Hello ${event.payload.email}`,
                plan: event.payload.plan,
              });
            },
          },
        },
      },
      queries: {
        contact: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { customerId: string } };
            table: Table<ContactRow>;
          }) => table.findOne({ customerId: query.payload.customerId }),
        },
        byEmail: {
          payload: ({ z }: PayloadArgs) => z.object({ email: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { email: string } };
            table: Table<ContactRow>;
          }) => table.findOne({ email: query.payload.email }),
        },
      },
    },
  },
} as unknown as Registry;

const adapters: readonly (readonly [string, () => Adapter])[] = [
  ["in memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

const stops: (() => Promise<void>)[] = [];

afterEach(async () => {
  auditDown = false;
  remembered.length = 0;
  contactsDown = false;
  upcastRead.length = 0;
  for (const stop of stops.splice(0)) await stop();
});

const setUp = async (adapter: Adapter) => {
  const redacted: unknown[] = [];
  const { app, clock } = await createTestApp({ registry, adapter });
  stops.push(() => app.stop());
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: unknown) => Promise<{ eventIds: readonly string[] }>
  >;
  const queries = app.queries as unknown as Record<string, (payload?: unknown) => Promise<unknown>>;
  const events = (): Promise<readonly StoredEvent[]> => app.events.read({ limit: 1_000 });
  const target = (event: StoredEvent, fields: readonly string[]): RedactedFields => ({
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    type: event.type,
    id: event.id,
    fields,
  });
  const exported = (personId: string) => app.exportPersonalData(personId);
  const registered = async (customerId: string, email: string) => {
    await commands.registerCustomer?.({ customerId, email, plan: "pro" });
    await app.runUntilIdle();
    const [event] = (await exported(customerId)).events;
    if (event === undefined) throw new Error("not registered");
    return event;
  };
  // Every event of the person whose fields hold the value, as their export lists them: what a
  // rectification redacts.
  const holding = async (personId: string, value: unknown): Promise<RedactedFields[]> =>
    (await exported(personId)).events.flatMap((event) => {
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
  // The reminders scheduled, and what a redaction keeps for the read models, but neither the
  // process's timeout nor the delayed policy's run.
  const scheduled = async () =>
    (
      (await adapter.inspect()).find(({ store }) => store === "scheduledCommands")?.rows ?? []
    ).filter((row) => /RemindCustomer|bounda\.RedactionScrub/.test(JSON.stringify(row)));
  return {
    app,
    clock,
    commands,
    queries,
    events,
    target,
    exported,
    registered,
    scheduled,
    redacted,
    holding,
  };
};

describe.each(adapters)("redact, %s", (_, adapterOf) => {
  it("seals the fields named for good, and the read models write null over their copies", async () => {
    const { app, commands, queries, exported, registered, scheduled, holding } = await setUp(
      adapterOf(),
    );
    const registration = await registered("ana", "ana@old.example");
    const wrong = await holding("ana", "ana@old.example");
    expect(wrong.map(({ type, fields }) => [type, fields])).toEqual([
      ["CustomerRegistered", ["email"]],
      ["ProcessHandled", ["contact"]],
    ]);
    const dispatch = await app.redact("ana", { events: wrong });
    expect(dispatch.eventTypes).toEqual(["PersonalDataRedacted"]);
    await commands.correctEmail?.({ customerId: "ana", email: "ana@new.example" });
    await app.runUntilIdle();
    const after = await exported("ana");
    expect(
      after.events
        .filter(({ redacted }) => redacted.length > 0)
        .map(({ type, data, redacted }) => [type, data, redacted]),
    ).toEqual([
      ["CustomerRegistered", { email: null }, ["email"]],
      ["ProcessHandled", { contact: null }, ["contact"]],
    ]);
    expect(after.events.find(({ type }) => type === "EmailCorrected")?.data).toEqual({
      email: "ana@new.example",
    });
    expect(after.redactions).toEqual([
      {
        eventId: dispatch.eventIds[0],
        at: expect.any(String),
        events: wrong.map(({ id, fields }) => ({ id, fields })),
      },
    ]);
    expect(registration.data).toEqual({ email: "ana@old.example" });
    expect(JSON.stringify(after)).not.toContain("ana@old.example");
    // The plan, which quotes nothing of the old email, stays.
    expect(await queries.contact?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: null,
      plan: "pro",
    });
    expect(await queries.byEmail?.({ email: "ana@old.example" })).toBeNull();
    expect(await scheduled()).toEqual([]);
    await expectRedacted(app, "ana");
  });

  it("finds an old value an event that was not redacted still holds", async () => {
    const { app, commands, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await commands.echoEmail?.({ customerId: "ana" });
    await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    await app.runUntilIdle();
    const error = await expectRedacted(app, "ana").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotRedactedError);
    expect((error as NotRedactedError).found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "ana@old.example", store: "bounda_events" }),
      ]),
    );
  });

  it("hands the aggregate null for a redacted field, and the next event what it decides on that", async () => {
    const { app, commands, exported, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    await commands.echoEmail?.({ customerId: "ana" });
    await app.runUntilIdle();
    expect((await exported("ana")).events.at(-1)).toMatchObject({
      type: "EmailEchoed",
      data: { email: null },
    });
  });

  it("appends nothing when nothing is left to redact, as on a second redaction of the same field", async () => {
    const { app, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    const first = await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    const again = await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    expect(again).toMatchObject({ eventIds: [], version: first.version });
  });

  it("refuses what it cannot reach", async () => {
    const { app, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    const refusals = [
      () => app.redact("", { events: [{ ...registration, fields: ["email"] }] }),
      () => app.redact("ana", { events: [] }),
      () => app.redact("ana", { events: [{ ...registration, fields: [] }] }),
      () => app.redact("ana", { events: [{ ...registration, fields: ["plan"] }] }),
      () =>
        app.redact("ana", {
          events: [{ ...registration, type: "EmailCorrected", fields: ["email"] }],
        }),
      () => app.redact("ana", { events: [{ ...registration, id: "missing", fields: ["email"] }] }),
      () => app.redact("bo", { events: [{ ...registration, fields: ["email"] }] }),
    ];
    for (const refusal of refusals) await expect(refusal()).rejects.toBeInstanceOf(ValidationError);
  });

  it("cancels a scheduled command whose payload holds an old value, and names it", async () => {
    const { app, commands, registered, events, scheduled } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@old.example" },
      { delay: "1d" },
    );
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@new.example" },
      { delay: "2d" },
    );
    await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    await app.runUntilIdle();
    const redaction = (await events()).at(-1);
    expect(redaction?.payload).toMatchObject({
      cancelledCommands: [{ type: "RemindCustomer" }],
    });
    expect(await scheduled()).toHaveLength(1);
  });

  it("redacts while the person's processing is restricted", async () => {
    const { app, exported, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] });
    expect((await exported("ana")).events[0]?.data).toEqual({ email: null });
  });

  it("appends nothing for a person forgotten already", async () => {
    const { app, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    await app.forget("ana");
    expect(
      await app.redact("ana", { events: [{ ...registration, fields: ["email"] }] }),
    ).toMatchObject({ eventIds: [] });
  });

  it("seals a field of a process's state in its lifecycle event, and the instance reads null", async () => {
    const { app, exported, registered } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    const handled = (await exported("ana")).events.find(({ type }) => type === "ProcessHandled");
    expect(handled).toMatchObject({
      aggregateType: "process:customer.contactProcess",
      data: { contact: "ana@old.example" },
    });
    if (handled === undefined) throw new Error("not handled");
    const started = (await exported("ana")).events.filter(
      ({ aggregateType }) => aggregateType === "process:customer.contactProcess",
    );
    await app.redact("ana", {
      events: started.map((event) => ({ ...event, fields: ["contact"] })) as never,
    });
    await app.runUntilIdle();
    const after = (await exported("ana")).events.filter(
      ({ aggregateType }) => aggregateType === "process:customer.contactProcess",
    );
    expect(after.map(({ data }) => data)).toEqual(after.map(() => ({ contact: null })));
  });

  it("seals for good a subscriber's last failure that quotes an old value", async () => {
    const { app, clock, registered, holding } = await setUp(adapterOf());
    auditDown = true;
    const registration = await registered("ana", "ana@old.example");
    auditDown = false;
    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(await app.subscriberFailures.get("projection:audit")).toMatchObject({
      errorMessage: "cannot index ana@old.example",
    });
    expect(registration.type).toBe("CustomerRegistered");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    expect(await app.subscriberFailures.get("projection:audit")).toMatchObject({
      errorMessage: null,
    });
    await expectRedacted(app, "ana");
  });

  it("redacts what a forgetting kept under a legal obligation", async () => {
    const { app, commands, exported } = await setUp(adapterOf());
    await commands.registerCustomer?.({ customerId: "ana", email: "ana@old.example", plan: "pro" });
    await commands.issueInvoice?.({ customerId: "ana", address: "1 Wrong St" });
    await app.runUntilIdle();
    await app.forget("ana");
    const invoice = (await exported("ana")).events.find(({ type }) => type === "InvoiceIssued");
    expect(invoice).toMatchObject({ data: { address: "1 Wrong St" }, restricted: ["address"] });
    if (invoice === undefined) throw new Error("not issued");
    expect((await exported("ana")).readModels.invoices).toEqual([
      expect.objectContaining({ data: { address: "1 Wrong St" } }),
    ]);
    await app.redact("ana", { events: [{ ...invoice, fields: ["address"] }] });
    await app.runUntilIdle();
    const after = await exported("ana");
    expect(after.events.find(({ type }) => type === "InvoiceIssued")).toMatchObject({
      data: { address: null },
      redacted: ["address"],
    });
    expect(after.readModels.invoices).toEqual([expect.objectContaining({ data: {} })]);
    await expectRedacted(app, "ana");
  });

  it("never brings an old value back when a read model is rebuilt", async () => {
    const { app, queries, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    expect(await app.rebuildReadModel("contacts")).toMatchObject({ done: true });
    expect(await queries.contact?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: null,
      plan: "pro",
    });
    await expectRedacted(app, "ana");
  });

  it("settles a redaction that races a forgetting, whichever commits first", async () => {
    const { app, registered } = await setUp(adapterOf());
    const registration = await registered("ana", "ana@old.example");
    const [redacted, forgotten] = await Promise.all([
      app.redact("ana", { events: [{ ...registration, fields: ["email"] }] }),
      app.forget("ana"),
    ]);
    await app.runUntilIdle();
    expect(forgotten.eventTypes).toEqual(["PersonalDataForgotten"]);
    expect(redacted.eventTypes.length).toBeLessThanOrEqual(1);
    await expectRedacted(app, "ana", { values: ["ana@old.example"] });
  });

  it("redacts again an old value a command that read it before the redaction wrote after it", async () => {
    const { app, commands, events, exported, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    // As a command decided on the state read before the redaction committed would.
    await commands.correctEmail?.({ customerId: "ana", email: "ana@old.example" });
    await app.runUntilIdle();
    const redactions = (await events()).filter(({ type }) => type === "PersonalDataRedacted");
    expect(redactions).toHaveLength(2);
    expect(
      (await exported("ana")).events.find(({ type }) => type === "EmailCorrected"),
    ).toMatchObject({ data: { email: null }, redacted: ["email"] });
    await expectRedacted(app, "ana");
  });

  it("hands a policy that runs after the redaction null for the field", async () => {
    const { app, clock, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(remembered).toEqual([null]);
  });

  it("hands an upcast of an older event null for the field", async () => {
    const adapter = adapterOf();
    const before = await createTestApp({ registry, adapter });
    await (
      before.app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).registerCustomer?.({ customerId: "ana", email: "ana@old.example", plan: "pro" });
    await before.app.runUntilIdle();
    const [registration] = (await before.app.exportPersonalData("ana")).events;
    if (registration === undefined) throw new Error("not registered");
    await before.app.redact("ana", { events: [{ ...registration, fields: ["email"] }] as never });
    await before.app.runUntilIdle();
    await before.app.stop();
    const upcasting = {
      ...registry,
      aggregates: {
        customer: {
          ...registry.aggregates.customer,
          upcasts: {
            customerRegistered: {
              upcasts: [
                (payload: { email: string | null }) => {
                  upcastRead.push(payload.email);
                  return payload;
                },
              ],
            },
          },
        },
      },
    } as unknown as Registry;
    const after = await createTestApp({ registry: upcasting, adapter });
    stops.push(() => after.app.stop());
    expect((await after.app.exportPersonalData("ana")).events[0]?.data).toEqual({ email: null });
    expect(upcastRead).toEqual([null]);
  });

  it("keeps what a read model has to write over until it has projected the redaction", async () => {
    const { app, clock, commands, queries, registered, holding, scheduled } = await setUp(
      adapterOf(),
    );
    await registered("ana", "ana@old.example");
    contactsDown = true;
    // Bo's registration holds the read model back, before the redaction.
    await commands.registerCustomer?.({ customerId: "bo", email: "bo@example.com", plan: "pro" });
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    expect(
      (await scheduled()).filter((row) => JSON.stringify(row).includes("RedactionScrub")),
    ).toHaveLength(1);
    contactsDown = false;
    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(await scheduled()).toEqual([]);
    expect(await queries.contact?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: null,
      plan: "pro",
    });
    await expectRedacted(app, "ana");
  });

  it("cancels a command holding an old value that work running at the redaction scheduled after it", async () => {
    const { app, commands, registered, holding, scheduled } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    // As a policy that read the old value just before the redaction committed would.
    await commands.remindCustomer?.(
      { customerId: "ana", email: "ana@old.example" },
      { delay: "1d" },
    );
    await app.runUntilIdle();
    expect(await scheduled()).toEqual([]);
    await expectRedacted(app, "ana");
  });

  it("waits for the read models before a client's catch-up through the redaction resolves", async () => {
    const { app, queries, registered, holding } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    const redacted = await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.catchUpReadModels({ through: redacted });
    expect(await queries.contact?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: null,
      plan: "pro",
    });
  });

  it("writes over the person's rows alone, every page of them", async () => {
    const { app, commands, queries, registered, holding } = await setUp(adapterOf());
    await registered("ana", "shared@old.example");
    await registered("bo", "bo@example.com");
    const ids = Array.from({ length: 205 }, (_, index) => `n-${String(index).padStart(3, "0")}`);
    for (const noteId of ids) {
      await commands.addNote?.({ customerId: "ana", noteId, text: "write to shared@old.example" });
    }
    await commands.addNote?.({ customerId: "bo", noteId: "bo-1", text: "shared@old.example" });
    await app.runUntilIdle();
    await app.redact("ana", { events: await holding("ana", "shared@old.example") });
    await app.runUntilIdle();
    const notes = (await queries.notesOf?.({ customerId: "ana" })) as readonly {
      readonly text: string | null;
    }[];
    expect(notes).toHaveLength(205);
    expect(notes.filter(({ text }) => text !== null)).toEqual([]);
    expect(await queries.notesOf?.({ customerId: "bo" })).toEqual([
      { noteId: "bo-1", customerId: "bo", text: "shared@old.example" },
    ]);
  }, 30_000);

  it("keeps what a rebuild under way has to write over until it has projected the redaction", async () => {
    const { app, clock, queries, registered, holding, scheduled } = await setUp(adapterOf());
    await registered("ana", "ana@old.example");
    await registered("bo", "bo@example.com");
    expect(await app.rebuildReadModel("contacts", { maxEvents: 1 })).toMatchObject({
      done: false,
    });
    await app.redact("ana", { events: await holding("ana", "ana@old.example") });
    await app.runUntilIdle();
    const kept = () =>
      scheduled().then((rows) =>
        rows.filter((row) => JSON.stringify(row).includes("RedactionScrub")),
      );
    expect(await kept()).toHaveLength(1);
    expect(await app.rebuildReadModel("contacts")).toMatchObject({ done: true });
    // The worker looks again a while after the rounds it waited.
    clock.advance(60_000);
    await app.runUntilIdle();
    expect(await kept()).toEqual([]);
    expect(await queries.contact?.({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: null,
      plan: "pro",
    });
  });
});
