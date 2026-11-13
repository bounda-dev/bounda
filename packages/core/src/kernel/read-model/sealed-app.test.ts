import { afterEach, describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectForgotten } from "../../testing/index.ts";

const DAY = 86_400_000;

interface CustomerRow {
  readonly customerId: string;
  readonly email: string | null;
  readonly plan: string;
}

interface InvoiceRow {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly address: string | null;
}

type Events = Record<string, (payload: unknown) => unknown>;

// Written through the driver, around the runtime, as a projection that takes `client.raw` may.
let rawNote: string | null = null;

const registry = {
  personalData: {
    categories: { invoices: { basis: "legal-obligation", retention: "6y" } },
  },
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()), plan: z.string() }),
          evolve: () => ({}),
        },
        invoiceIssued: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              invoiceId: z.string(),
              address: personal(z.string(), { category: "invoices" as never }),
            }),
          evolve: () => ({}),
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
            }) => [
              events.customerRegistered?.({
                email: command.payload.email,
                plan: command.payload.plan,
              }),
            ],
          },
        },
        issueInvoice: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), invoiceId: z.string(), address: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { invoiceId: string; address: string } };
              events: Events;
            }) => [
              events.invoiceIssued?.({
                invoiceId: command.payload.invoiceId,
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
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal().unique(),
          note: f.string().optional().personal(),
          plan: f.string(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
              client,
            }: {
              event: { aggregateId: string; payload: { email: string | null; plan: string } };
              table: Table<CustomerRow & { note?: string | null }>;
              client: ReadClient<CustomerRow, unknown>;
            }) => {
              await table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email,
                plan: event.payload.plan,
              });
              if (rawNote === null) return;
              const raw = client.raw as Table<Record<string, unknown>>;
              await raw.update({ customerId: event.aggregateId }, { note: rawNote });
            },
          },
        },
      },
      queries: {
        byEmail: {
          payload: ({ z }: PayloadArgs) => z.object({ email: z.string() }),
          repository: ({ email, table }: { email: string; table: Table<CustomerRow> }) =>
            table.findOne({ email }),
          handler: ({ repositoryData }: { repositoryData: CustomerRow | null }) => repositoryData,
        },
        everyone: {
          handler: ({ table }: { table: Table<CustomerRow & { note?: string | null }> }) =>
            table.findMany({ orderBy: { field: "customerId", direction: "asc" } }),
        },
      },
    },
    invoices: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          invoiceId: f.string().primaryKey(),
          customerId: f.string().index().person(),
          address: f.string().personal({ category: "invoices" as never }),
        }),
      },
      projections: {
        customer: {
          invoiceIssued: {
            project: ({
              event,
              table,
            }: {
              event: {
                aggregateId: string;
                payload: { invoiceId: string; address: string | null };
              };
              table: Table<InvoiceRow>;
            }) =>
              table.upsert({
                invoiceId: event.payload.invoiceId,
                customerId: event.aggregateId,
                address: event.payload.address,
              }),
          },
        },
      },
      queries: {
        invoicesOf: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { customerId: string } };
            table: Table<InvoiceRow>;
          }) =>
            table.findMany({
              where: { customerId: query.payload.customerId },
              orderBy: { field: "invoiceId", direction: "asc" },
            }),
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
  rawNote = null;
  for (const stop of stops.splice(0)) await stop();
});

const setUp = async (adapter: Adapter) => {
  const accesses: PersonalDataAccess[] = [];
  const { app, clock } = await createTestApp({
    registry,
    adapter,
    onPersonalDataAccess: ({ access }) => {
      accesses.push(access);
    },
  });
  stops.push(() => app.stop());
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown) => Promise<unknown>
  >;
  const queries = app.queries as unknown as Record<
    string,
    (payload?: unknown, options?: { includeRestricted?: RestrictionBasis }) => Promise<unknown>
  >;
  const register = async (customerId: string, email = `${customerId}@example.com`) => {
    await commands.registerCustomer?.({ customerId, email, plan: "pro" });
    await app.runUntilIdle();
  };
  const invoice = async (customerId: string, invoiceId: string, address: string) => {
    await commands.issueInvoice?.({ customerId, invoiceId, address });
    await app.runUntilIdle();
  };
  const rows = async (readModel: string) =>
    (await adapter.inspect()).find(({ name }) => name === `bounda_rm_${readModel}`)?.rows ?? [];
  return { app, clock, adapter, queries, register, invoice, rows, accesses };
};

describe.each(adapters)("read models sealed at rest, %s", (_, adapterOf) => {
  it("keeps only ciphertext in the table, and opens it for queries", async () => {
    const { queries, register, rows } = await setUp(adapterOf());
    await register("ana");
    const [stored] = await rows("customers");
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect(String(stored?.email)).toMatch(/^\{"\$personal":/);
    expect(stored?.email__key).toEqual(expect.any(String));
    expect(stored?.email__index).toEqual(expect.any(String));
    expect(await queries.everyone?.()).toEqual([
      { customerId: "ana", email: "ana@example.com", plan: "pro" },
    ]);
  });

  it("finds a row by a sealed value through its blind index, and by no other value", async () => {
    const { queries, register } = await setUp(adapterOf());
    await register("ana");
    await register("bo");
    expect(await queries.byEmail?.({ email: "bo@example.com" })).toMatchObject({
      customerId: "bo",
    });
    expect(await queries.byEmail?.({ email: "BO@example.com" })).toBeNull();
  });

  it("forgets a person without a projection of the forgetting: the values read as null, the blind index is emptied, and nothing is left to find", async () => {
    const { app, queries, register, rows } = await setUp(adapterOf());
    await register("ana");
    await register("bo");
    await app.forget("ana");
    await app.runUntilIdle();
    expect(await queries.everyone?.()).toEqual([
      { customerId: "ana", email: null, plan: "pro" },
      { customerId: "bo", email: "bo@example.com", plan: "pro" },
    ]);
    expect(await queries.byEmail?.({ email: "ana@example.com" })).toBeNull();
    const ana = (await rows("customers")).find(
      (row) => row.customer_id === "ana" || row.customerId === "ana",
    );
    expect(ana?.email__index ?? null).toBeNull();
    await expectForgotten(app, "ana");
  });

  it("hides the rows a forgetting kept under a legal obligation, reads them on that basis, and reads those of the person written after they came back", async () => {
    const { app, clock, queries, register, invoice } = await setUp(adapterOf());
    await register("ana");
    await invoice("ana", "i-1", "1 Old St");
    await app.forget("ana");
    await app.runUntilIdle();
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([]);
    expect(
      await queries.invoicesOf?.({ customerId: "ana" }, { includeRestricted: "legal-obligation" }),
    ).toEqual([{ invoiceId: "i-1", customerId: "ana", address: "1 Old St" }]);
    clock.set(new Date(clock.now().getTime() + 3 * 365 * DAY));
    await invoice("ana", "i-2", "2 New St");
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([
      { invoiceId: "i-2", customerId: "ana", address: "2 New St" },
    ]);
    // Projected again from the start, each row goes under the key its event was opened under.
    await app.rebuildReadModel("invoices");
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([
      { invoiceId: "i-2", customerId: "ana", address: "2 New St" },
    ]);
    clock.set(new Date(clock.now().getTime() + (3 * 365 + 10) * DAY));
    await app.runUntilIdle();
    const expired = (await app.events.read({ limit: 100 })).filter(
      (event) =>
        event.type === "PersonalDataForgotten" &&
        (event.payload as { expired: readonly string[] }).expired.includes("invoices"),
    );
    expect(expired).toHaveLength(1);
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([
      { invoiceId: "i-1", customerId: "ana", address: null },
      { invoiceId: "i-2", customerId: "ana", address: "2 New St" },
    ]);
  });

  it("exports what a read model holds of the person opened, marking what a forgetting kept as restricted", async () => {
    const { app, register, invoice } = await setUp(adapterOf());
    await register("ana");
    await invoice("ana", "i-1", "1 Old St");
    await app.forget("ana");
    await app.runUntilIdle();
    await register("ana", "ana@new.example");
    await invoice("ana", "i-2", "2 New St");
    const exported = await app.exportPersonalData("ana");
    expect(exported.readModels.invoices).toEqual([
      expect.objectContaining({
        key: "i-1",
        data: { address: "1 Old St" },
        restricted: ["address"],
      }),
      expect.objectContaining({ key: "i-2", data: { address: "2 New St" }, restricted: [] }),
    ]);
    expect(exported.readModels.customers).toEqual([
      expect.objectContaining({ key: "ana", data: { email: "ana@new.example" }, restricted: [] }),
    ]);
  });

  it("records in the access log the restricted persons a basis opened, by the keys of their rows", async () => {
    const { app, queries, register, invoice, accesses } = await setUp(adapterOf());
    await register("ana");
    await invoice("ana", "i-1", "1 Old St");
    await app.forget("ana");
    await app.runUntilIdle();
    accesses.length = 0;
    await queries.invoicesOf?.({ customerId: "ana" }, { includeRestricted: "legal-obligation" });
    expect(accesses).toEqual([
      expect.objectContaining({
        operation: "query",
        persons: ["ana"],
        restricted: { basis: "legal-obligation", persons: ["ana"], personCount: 1 },
      }),
    ]);
  });
});

describe("a value a projection writes through client.raw into a sealed field", () => {
  it("is sealed before the batch commits", async () => {
    rawNote = "written raw";
    const adapter = memory();
    const { queries, register, rows } = await setUp(adapter);
    await register("ana");
    const [stored] = await rows("customers");
    expect(JSON.stringify(stored)).not.toContain("written raw");
    expect(String(stored?.note)).toMatch(/^\{"\$personal":/);
    expect(await queries.everyone?.()).toEqual([
      { customerId: "ana", email: "ana@example.com", note: "written raw", plan: "pro" },
    ]);
  });
});

describe("a read model whose personal fields change, on SQLite", () => {
  const withEmail = (email: (f: FieldsArgs["f"]) => unknown) =>
    ({
      ...registry,
      readModels: {
        customers: {
          ...(registry.readModels.customers as object),
          view: {
            fields: ({ f }: FieldsArgs) => ({
              customerId: f.string().primaryKey().person(),
              email: email(f),
              note: f.string().optional().personal(),
              plan: f.string(),
            }),
          },
          projections: {
            ...(registry.readModels.customers?.projections as object),
            bounda: { personalDataForgotten: { project: () => undefined } },
          },
        },
      },
    }) as unknown as Registry;

  const harness = () => {
    const adapter = createNodeSqliteAdapter().adapter;
    const logged: string[] = [];
    const logger = {
      debug: () => undefined,
      info: (message: string) => {
        logged.push(message);
      },
      warn: () => undefined,
      error: () => undefined,
    };
    const boot = async (booted: Registry) => {
      const { app } = await createTestApp({ registry: booted, adapter, logger });
      stops.push(() => app.stop());
      return app;
    };
    const stored = async () =>
      (await adapter.inspect()).find(({ name }) => name === "bounda_rm_customers")?.rows[0];
    const register = async (app: Awaited<ReturnType<typeof boot>>) => {
      await (
        app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
      ).registerCustomer?.({ customerId: "ana", email: "ana@example.com", plan: "pro" });
      await app.runUntilIdle();
      await app.stop();
    };
    const settlings = () => logged.filter((message) => message === "read model settled").length;
    return { boot, stored, register, settlings };
  };

  it("seals at the start what an earlier version kept in the clear, with its blind index, once", async () => {
    const { boot, stored, register, settlings } = harness();
    await register(await boot(withEmail((f) => f.string().personal({ clear: true }))));
    expect((await stored())?.email).toBe("ana@example.com");

    const sealedApp = await boot(withEmail((f) => f.string().personal().index()));
    expect(String((await stored())?.email)).toMatch(/^\{"\$personal":/);
    expect((await stored())?.email__index).toEqual(expect.any(String));
    const queries = sealedApp.queries as unknown as Record<
      string,
      (payload?: unknown) => Promise<unknown>
    >;
    expect(await queries.byEmail?.({ email: "ana@example.com" })).toMatchObject({
      customerId: "ana",
      email: "ana@example.com",
    });
    await sealedApp.stop();
    const settled = settlings();
    await (await boot(withEmail((f) => f.string().personal().index()))).stop();
    expect(settlings()).toBe(settled);
  });

  it("opens at the start what an earlier version sealed in a field now kept in the clear", async () => {
    const { boot, stored, register } = harness();
    await register(await boot(withEmail((f) => f.string().personal())));
    expect(String((await stored())?.email)).toMatch(/^\{"\$personal":/);
    const clearApp = await boot(withEmail((f) => f.string().personal({ clear: true })));
    expect((await stored())?.email).toBe("ana@example.com");
    await clearApp.stop();
  });
});
