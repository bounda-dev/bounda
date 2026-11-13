import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";
import { PROCESSING_RESTRICTED } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RestrictionBasis } from "../../modules/personal-data.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";

type Events = Record<string, (payload?: unknown) => unknown>;

interface CustomerRow {
  readonly customerId: string;
  readonly email?: string;
  readonly plan: string;
}

interface InvoiceRow {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly address?: string;
}

const DAY_MS = 86_400_000;

const welcomed: string[] = [];
const reported: string[] = [];
const called: string[] = [];
const addresses: (string | null)[] = [];
const archived: (string | null)[] = [];
const printed: (string | null)[] = [];
const followed: string[] = [];
const escalated: string[] = [];
const filed: (string | null)[] = [];
const audited: (string | null)[] = [];
const reminded: (string | null)[] = [];
const recalled: (string | null)[] = [];

interface CallProcessConfigArgs {
  readonly events: {
    readonly customer: { readonly CustomerCalled: unknown; readonly InvoiceIssued: unknown };
  };
}

const invoiceProcess = (seen: (string | null)[], restricted?: RestrictionBasis) => ({
  module: {
    config: ({ events }: CallProcessConfigArgs) => ({
      startedBy: [events.customer.InvoiceIssued],
      timeout: "30d",
    }),
    ...(restricted === undefined ? {} : { restricted }),
  },
  handlers: {
    customer: {
      invoiceIssued: {
        handler: ({ event }: { event: { payload: { address: string | null } } }) => {
          seen.push(event.payload.address);
        },
      },
    },
  },
});

// Keeps the address of the invoice in its state, and reads it an hour later.
const reminderProcess = (seen: (string | null)[], restricted?: RestrictionBasis) => ({
  module: {
    config: ({ events }: CallProcessConfigArgs) => ({
      startedBy: [events.customer.InvoiceIssued],
      timeout: "30d",
    }),
    state: ({ z, deadline, personal, person }: ProcessStateArgs) =>
      z.object({
        customerId: person(z.string()).nullable().default(null),
        address: personal(z.string(), { category: "invoices" }).nullable().default(null),
        nudge: deadline(),
      }),
    ...(restricted === undefined ? {} : { restricted }),
  },
  handlers: {
    customer: {
      invoiceIssued: {
        handler: ({
          aggregateId,
          event,
          after,
        }: {
          aggregateId: string;
          event: { payload: { address: string | null } };
          after: (delay: string) => string;
        }) => ({ customerId: aggregateId, address: event.payload.address, nudge: after("1h") }),
      },
    },
  },
  deadlines: {
    nudge: {
      handler: ({ state }: { state: { address: string | null } }) => {
        seen.push(state.address);
        return { nudge: null };
      },
    },
  },
});

const callProcess = (seen: string[], restricted?: RestrictionBasis) => ({
  module: {
    config: ({ events }: CallProcessConfigArgs) => ({
      startedBy: [events.customer.CustomerCalled],
      timeout: "30d",
    }),
    ...(restricted === undefined ? {} : { restricted }),
  },
  handlers: {
    customer: {
      customerCalled: {
        handler: ({ aggregateId }: { aggregateId: string }) => {
          seen.push(aggregateId);
        },
      },
    },
  },
});

const registryWith = ({ reportBasis }: { readonly reportBasis?: RestrictionBasis } = {}) =>
  ({
    personalData: {
      categories: {
        marketing: { basis: "consent", retention: "730d" },
        invoices: { basis: "legal-obligation", retention: "6y" },
      },
    },
    aggregates: {
      customer: {
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                email: personal(z.email()),
                newsletter: personal(z.email(), { category: "marketing" }).optional(),
                plan: z.string(),
              }),
            evolve: () => ({}),
          },
          customerNudged: {
            payload: ({ z }: EventPayloadArgs) => z.object({}),
            evolve: () => ({}),
          },
          invoiceIssued: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                invoiceId: z.string(),
                address: personal(z.string(), { category: "invoices" }),
              }),
            evolve: ({
              state,
              event,
            }: {
              state: object;
              event: { payload: { address: string | null } };
            }) => ({ ...state, address: event.payload.address }),
          },
          customerCalled: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ note: personal(z.string()).optional() }),
            evolve: () => ({}),
          },
        },
        commands: {
          registerCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) =>
                z.object({
                  customerId: z.string(),
                  email: z.email(),
                  newsletter: z.email().optional(),
                  plan: z.string(),
                }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { email: string; newsletter?: string; plan: string } };
                events: Events;
              }) => [events.customerRegistered?.(command.payload)],
            },
          },
          nudgeCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
              handler: ({ events }: { events: Events }) => [events.customerNudged?.({})],
            },
          },
          callCustomer: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
              handler: ({ events }: { events: Events }) => [events.customerCalled?.({})],
            },
          },
          printInvoice: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
              handler: ({ state }: { state: { address?: string | null } }) => {
                printed.push(state.address ?? null);
                return [];
              },
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
              }) => [events.invoiceIssued?.(command.payload)],
            },
          },
        },
        policies: {
          logOnCustomerCalled: {
            module: {
              handler: ({ event }: { event: { aggregateId: string } }) => {
                called.push(event.aggregateId);
              },
            },
          },
          sendOnInvoiceIssued: {
            module: {
              handler: ({ event }: { event: { payload: { address: string | null } } }) => {
                addresses.push(event.payload.address);
              },
            },
          },
          archiveOnInvoiceIssued: {
            module: {
              on: "InvoiceIssued",
              restricted: "legal-obligation",
              handler: ({ event }: { event: { payload: { address: string | null } } }) => {
                archived.push(event.payload.address);
              },
            },
          },
          welcomeOnCustomerRegistered: {
            module: {
              handler: ({ event }: { event: { aggregateId: string } }) => {
                welcomed.push(event.aggregateId);
              },
            },
          },
          reportOnCustomerRegistered: {
            module: {
              on: "CustomerRegistered",
              ...(reportBasis === undefined ? {} : { restricted: reportBasis }),
              handler: async ({
                event,
                commands,
              }: {
                event: { aggregateId: string };
                commands: {
                  nudgeCustomer: (payload: unknown, options?: object) => Promise<unknown>;
                };
              }) => {
                reported.push(event.aggregateId);
                if (reportBasis === undefined) return;
                await commands.nudgeCustomer({ customerId: event.aggregateId });
                // A delayed command goes without the basis, which would refuse it otherwise.
                if (event.aggregateId === "bo") {
                  await commands.nudgeCustomer({ customerId: "bo" }, { delay: "1h" });
                }
              },
            },
          },
        },
        processes: {
          followCalls: callProcess(followed),
          escalateCalls: callProcess(escalated, "legal-claims"),
          fileInvoices: invoiceProcess(filed),
          auditInvoices: invoiceProcess(audited, "legal-obligation"),
          remindInvoices: reminderProcess(reminded),
          recallInvoices: reminderProcess(recalled, "legal-obligation"),
        },
      },
    },
    readModels: {
      customers: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            customerId: f.string().primaryKey().person(),
            email: f.string().optional().personal(),
            plan: f.string().index(),
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
                table: Table<CustomerRow>;
              }) =>
                table.upsert({
                  customerId: event.aggregateId,
                  ...(event.payload.email === null ? {} : { email: event.payload.email }),
                  plan: event.payload.plan,
                }),
            },
          },
          bounda: {
            personalDataForgotten: {
              project: ({
                event,
                table,
              }: {
                event: { payload: { personId: string } };
                table: Table<CustomerRow>;
              }) => table.delete({ customerId: event.payload.personId }),
            },
          },
        },
        queries: {
          customersOnPlan: {
            payload: ({ z }: PayloadArgs) => z.object({ plan: z.string() }),
            repository: ({ plan, table }: { plan: string; table: Table<CustomerRow> }) =>
              table.findMany({
                where: { plan },
                orderBy: { field: "customerId", direction: "asc" },
              }),
            handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
              repositoryData.map((row) => row.customerId),
          },
          firstCustomers: {
            handler: async ({ table }: { table: Table<CustomerRow> }) =>
              (
                await table.findMany({
                  orderBy: { field: "customerId", direction: "asc" },
                  limit: 2,
                })
              ).map((row) => row.customerId),
          },
          customerCount: {
            handler: ({ table }: { table: Table<CustomerRow> }) => table.count(),
          },
          customer: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            handler: ({
              query,
              table,
            }: {
              query: { payload: { customerId: string } };
              table: Table<CustomerRow>;
            }) => table.findOne({ customerId: query.payload.customerId }),
          },
          bySql: {
            repository: ({ client }: { client: ReadClient<CustomerRow> }) =>
              client.all(
                'SELECT "customer_id", "email" FROM "bounda_rm_customers" ORDER BY "customer_id"',
              ),
            handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
              repositoryData.map((row) => row.customerId),
          },
          emailsBySql: {
            repository: ({ client }: { client: ReadClient<CustomerRow> }) =>
              client.all('SELECT "email" FROM "bounda_rm_customers"'),
            handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
              repositoryData.length,
          },
          composed: {
            handler: ({
              queries,
            }: {
              queries: { customersOnPlan: (payload: { plan: string }) => Promise<string[]> };
            }) => queries.customersOnPlan({ plan: "pro" }),
          },
        },
      },
      invoices: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            invoiceId: f.string().primaryKey(),
            customerId: f.string().index().person(),
            address: f.string().optional().personal({ category: "invoices" }),
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
                  ...(event.payload.address === null ? {} : { address: event.payload.address }),
                }),
            },
          },
          bounda: { personalDataForgotten: { project: () => undefined } },
        },
        queries: {
          invoicesOf: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            repository: ({ customerId, table }: { customerId: string; table: Table<InvoiceRow> }) =>
              table.findMany({ where: { customerId } }),
            handler: ({ repositoryData }: { repositoryData: readonly InvoiceRow[] }) =>
              repositoryData.map((row) => row.invoiceId),
          },
        },
      },
    },
  }) as unknown as Registry;

const setup = async ({
  adapter = memory(),
  invoicesOn,
  reportBasis,
}: {
  readonly adapter?: Adapter;
  readonly invoicesOn?: Adapter;
  readonly reportBasis?: RestrictionBasis;
} = {}) => {
  for (const seen of [
    welcomed,
    reported,
    called,
    addresses,
    archived,
    printed,
    followed,
    escalated,
    filed,
    audited,
    reminded,
    recalled,
  ]) {
    seen.length = 0;
  }
  const accesses: PersonalDataAccess[] = [];
  const { app, clock } = await createTestApp({
    registry: registryWith(reportBasis === undefined ? {} : { reportBasis }),
    adapter,
    config: invoicesOn === undefined ? {} : { readModels: { invoices: invoicesOn } },
    onPersonalDataAccess: ({ access }) => {
      accesses.push(access);
    },
  });
  const queries = app.queries as unknown as Record<
    string,
    (payload?: unknown, options?: { includeRestricted?: RestrictionBasis }) => Promise<unknown>
  >;
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: { processRestricted?: RestrictionBasis }) => Promise<unknown>
  >;
  const register = async (customerId: string, plan = "pro") => {
    await commands.registerCustomer?.({
      customerId,
      email: `${customerId}@example.com`,
      newsletter: `${customerId}@news.example`,
      plan,
    });
  };
  return { app, clock, queries, commands, register, accesses };
};

const adapters: readonly (readonly [string, () => Adapter])[] = [
  ["memory", () => memory()],
  ["SQLite (node:sqlite)", () => createNodeSqliteAdapter().adapter],
];

describe.each(adapters)("restriction of processing on %s", (_name, adapterOf) => {
  it("leaves the rows of a person restricted as a whole out of every query, before a page is cut or counted, and back once lifted", async () => {
    const { app, queries, register } = await setup({ adapter: adapterOf() });
    for (const customer of ["ana", "bo", "cy"]) await register(customer);
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.catchUpReadModels();

    expect(await queries.customersOnPlan?.({ plan: "pro" })).toEqual(["bo", "cy"]);
    expect(await queries.firstCustomers?.()).toEqual(["bo", "cy"]);
    expect(await queries.customerCount?.()).toBe(2);
    expect(await queries.customer?.({ customerId: "ana" })).toBeNull();
    expect(await queries.composed?.()).toEqual(["bo", "cy"]);

    await app.unrestrict("ana", { notice: "given" });
    await app.catchUpReadModels();
    expect(await queries.firstCustomers?.()).toEqual(["ana", "bo"]);
    expect(await queries.customerCount?.()).toBe(3);
    await app.stop();
  });

  it("reads restricted rows on a basis named explicitly, records whose, and hands the basis to the queries it composes", async () => {
    const { app, queries, register, accesses } = await setup({ adapter: adapterOf() });
    for (const customer of ["ana", "bo"]) await register(customer);
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "legal-claims" });
    await app.catchUpReadModels();
    accesses.length = 0;

    expect(
      await queries.customersOnPlan?.({ plan: "pro" }, { includeRestricted: "legal-claims" }),
    ).toEqual(["ana", "bo"]);
    expect(accesses).toMatchObject([
      {
        operation: "query",
        persons: ["ana", "bo"],
        restricted: { basis: "legal-claims", persons: ["ana"], personCount: 1 },
      },
    ]);
    accesses.length = 0;
    expect(await queries.customersOnPlan?.({ plan: "pro" })).toEqual(["bo"]);
    expect(accesses).toMatchObject([{ persons: ["bo"], restricted: null }]);
    expect(await queries.composed?.(undefined, { includeRestricted: "consent" })).toEqual([
      "ana",
      "bo",
    ]);
    expect(
      await queries.customersOnPlan?.({ plan: "pro" }, { includeRestricted: "legal-obligation" }),
    ).toEqual(["bo"]);
    await expect(
      queries.customersOnPlan?.(
        { plan: "pro" },
        {
          includeRestricted: "curiosity" as RestrictionBasis,
        },
      ),
    ).rejects.toThrow("query CustomersOnPlan names a basis restricted data is not read on");
    await app.stop();
  });

  it("leaves rows out by the categories a read model holds: a category restriction hides only the read models that hold it", async () => {
    const { app, queries, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "objection-pending", categories: ["invoices"] });
    await app.catchUpReadModels();
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([]);
    expect(await queries.customersOnPlan?.({ plan: "pro" })).toEqual(["ana"]);
    await app.restrict("ana", { ground: "objection-pending", categories: ["marketing"] });
    await app.catchUpReadModels();
    expect(await queries.customersOnPlan?.({ plan: "pro" })).toEqual(["ana"]);
    await app.stop();
  });

  it("treats what a forgetting kept under a legal obligation as restricted, read on legal-obligation alone", async () => {
    const { app, queries, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    await app.runUntilIdle();
    await app.forget("ana");
    await app.catchUpReadModels();
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([]);
    expect(
      await queries.invoicesOf?.({ customerId: "ana" }, { includeRestricted: "legal-obligation" }),
    ).toEqual(["i-1"]);
    await expect(
      commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-2", address: "2 Main St" }),
    ).resolves.toBeDefined();
    await app.stop();
  });

  it("refuses a command that reads data a restriction covers before its handler runs, and lets it through on a basis, recorded on its events and in the access log", async () => {
    const { app, commands, register, accesses } = await setup({ adapter: adapterOf() });
    await register("ana");
    await register("bo");
    await app.runUntilIdle();
    accesses.length = 0;
    await commands.nudgeCustomer?.({ customerId: "bo" }, { processRestricted: "consent" });
    expect(accesses).toEqual([]);
    const registered = (await app.events.read()).find(
      (event) => event.type === "CustomerRegistered",
    );
    expect(registered?.metadata).not.toHaveProperty("restrictionBasis");
    await app.restrict("ana", { ground: "accuracy-contested", categories: ["marketing"] });
    await expect(commands.nudgeCustomer?.({ customerId: "ana" })).rejects.toMatchObject({
      code: PROCESSING_RESTRICTED,
      personId: "ana",
    });
    accesses.length = 0;
    await commands.nudgeCustomer?.({ customerId: "ana" }, { processRestricted: "consent" });
    const nudged = (await app.events.read()).findLast((event) => event.type === "CustomerNudged");
    expect(nudged?.metadata.restrictionBasis).toBe("consent");
    expect(accesses).toMatchObject([
      {
        operation: "command",
        detail: { handler: "NudgeCustomer" },
        persons: ["ana"],
        restricted: { basis: "consent", persons: ["ana"] },
      },
    ]);
    await expect(
      commands.nudgeCustomer?.(
        { customerId: "ana" },
        {
          processRestricted: "legal-obligation",
        },
      ),
    ).rejects.toMatchObject({ code: PROCESSING_RESTRICTED });
    await app.stop();
  });

  it("holds a policy on an event of a restricted person as a dead letter, runs one declared restricted, and retries the held one once the lift comes", async () => {
    const { app, clock, register, accesses, commands } = await setup({
      adapter: adapterOf(),
      reportBasis: "legal-claims",
    });
    await app.restrict("ana", { ground: "objection-pending" });
    await commands.registerCustomer?.(
      { customerId: "ana", email: "ana@example.com", plan: "pro" },
      { processRestricted: "consent" },
    );
    await register("bo");
    accesses.length = 0;
    await app.runUntilIdle();
    expect(welcomed).toEqual(["bo"]);
    expect(reported).toEqual(["ana", "bo"]);
    expect(accesses).toContainEqual(
      expect.objectContaining({
        operation: "policy",
        detail: { handler: "customer.reportOnCustomerRegistered" },
        restricted: { basis: "legal-claims", persons: ["ana"], personCount: 1 },
      }),
    );
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      handler: "customer.welcomeOnCustomerRegistered",
      errorCode: PROCESSING_RESTRICTED,
      person: "ana",
      errorMessage: null,
      restricted: true,
    });
    // Its commands carry its basis, but for a delayed one, which runs when the basis may not hold.
    clock.advance(3_600_000);
    await app.runUntilIdle();
    const nudged = (await app.events.read({ limit: 100 })).filter(
      (event) => event.type === "CustomerNudged",
    );
    expect(
      nudged.map(({ aggregateId, metadata }) => [aggregateId, metadata.restrictionBasis]),
    ).toEqual([
      ["ana", "legal-claims"],
      ["bo", "legal-claims"],
      ["bo", undefined],
    ]);
    expect(await app.deadLetters.list()).toHaveLength(1);
    await app.unrestrict("ana", { notice: "given" });
    await app.runUntilIdle();
    expect(welcomed).toEqual(["bo", "ana"]);
    await app.stop();
  });

  it("announces a lift with a notice, keeps the restriction until it is due, and lifts it then, unless a restriction on the ground came first", async () => {
    const { app, queries, register, clock } = await setup({ adapter: adapterOf() });
    await register("ana");
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.unrestrict("ana", { notice: "7d" });
    await app.runUntilIdle();
    expect(await queries.customerCount?.()).toBe(0);
    clock.advance(7 * DAY_MS);
    await app.runUntilIdle();
    expect(await queries.customerCount?.()).toBe(1);
    const types = (await app.events.read())
      .filter((event) => event.aggregateType === "bounda")
      .map((event) => event.type);
    expect(types).toEqual([
      "ProcessingRestricted",
      "ProcessingRestrictionLiftAnnounced",
      "ProcessingRestrictionLifted",
    ]);

    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.unrestrict("ana", { notice: "7d" });
    await app.restrict("ana", { ground: "accuracy-contested", categories: ["marketing"] });
    await app.restrict("ana", { ground: "objection-pending" });
    clock.advance(7 * DAY_MS);
    await app.runUntilIdle();
    expect(await queries.customerCount?.()).toBe(0);
    await app.stop();
  });

  it("keeps restricted rows out while a read model added since takes the copy over, reading the stream again", async () => {
    const adapter = adapterOf();
    const before = await setup({ adapter });
    await before.register("ana");
    await before.register("bo");
    await before.app.restrict("ana", { ground: "legal-claims" });
    await before.app.unrestrict("ana", { notice: "given" });
    await before.app.restrict("ana", { ground: "legal-claims" });
    await before.app.runUntilIdle();
    await before.app.stop();

    // Every write to the copy while the subscriber named after `accounts` catches up.
    const requested: (readonly unknown[])[] = [];
    const watched: Adapter = {
      ...adapter,
      createReadModel: async <Row extends object>(
        args: Parameters<Adapter["createReadModel"]>[0],
      ) => {
        const storage = await adapter.createReadModel<Row>(args);
        return {
          ...storage,
          transact: (transaction) =>
            storage.transact({
              ...transaction,
              work: (stores) =>
                transaction.work({
                  ...stores,
                  restrictedPersons: {
                    ...stores.restrictedPersons,
                    request: async (person, restrictions) => {
                      requested.push([person, restrictions]);
                      await stores.restrictedPersons.request(person, restrictions);
                    },
                  },
                }),
            }),
        } as typeof storage;
      },
    };
    const registry = registryWith();
    const { app } = await createTestApp({
      registry: {
        ...registry,
        readModels: {
          ...registry.readModels,
          accounts: {
            view: {
              fields: ({ f }: FieldsArgs) => ({
                customerId: f.string().primaryKey().person(),
              }),
            },
            projections: {},
            queries: {},
          },
        },
      },
      adapter: watched,
    });
    await app.runUntilIdle();
    expect(requested).toEqual([]);
    const queries = app.queries as unknown as Record<
      string,
      (payload: unknown) => Promise<unknown>
    >;
    expect(await queries.customersOnPlan?.({ plan: "pro" })).toEqual(["bo"]);
    await app.stop();
  });

  it("refuses a basis that is none, and one given to a delayed command", async () => {
    const { app, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await expect(
      commands.nudgeCustomer?.(
        { customerId: "ana" },
        {
          processRestricted: "curiosity" as RestrictionBasis,
        },
      ),
    ).rejects.toMatchObject({
      message: "command NudgeCustomer names a basis restricted data is not processed on",
      issues: [
        {
          path: ["processRestricted"],
          message:
            'Expected one of "consent", "legal-claims", "protection-of-rights", "public-interest", "legal-obligation"',
        },
      ],
    });
    await expect(
      commands.nudgeCustomer?.({ customerId: "ana" }, {
        processRestricted: "consent",
        delay: "1h",
      } as never),
    ).rejects.toMatchObject({
      message: "command NudgeCustomer is scheduled with processRestricted",
      issues: [
        {
          path: ["processRestricted"],
          message: "A basis holds when it is given; dispatch the command then, without delay",
        },
      ],
    });
    await app.stop();
  });

  it("holds a policy on an event that names a person restricted as a whole, though it carries none of their data", async () => {
    const { app, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.callCustomer?.({ customerId: "ana" });
    await app.runUntilIdle();
    expect(called).toEqual(["ana"]);
    await commands.callCustomer?.({ customerId: "ana" });
    await app.restrict("ana", { ground: "objection-pending" });
    await app.runUntilIdle();
    expect(called).toEqual(["ana"]);
    expect((await app.deadLetters.list()).map(({ handler }) => handler)).toContain(
      "customer.logOnCustomerCalled",
    );
    await app.stop();
  });

  it("holds a process step on a restricted person, and runs and records one of a process declared restricted", async () => {
    const { app, commands, register, accesses } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.callCustomer?.({ customerId: "ana" });
    accesses.length = 0;
    await app.runUntilIdle();
    expect(escalated).toEqual(["ana"]);
    expect(accesses.filter(({ operation }) => operation === "process")).toEqual([]);
    escalated.length = 0;
    followed.length = 0;
    await app.restrict("ana", { ground: "legal-claims" });
    await commands.callCustomer?.({ customerId: "ana" }, { processRestricted: "legal-claims" });
    accesses.length = 0;
    await app.runUntilIdle();
    expect(followed).toEqual([]);
    expect(escalated).toEqual(["ana"]);
    expect(accesses).toContainEqual(
      expect.objectContaining({
        operation: "process",
        detail: { handler: "customer.escalateCalls" },
        restricted: { basis: "legal-claims", persons: ["ana"], personCount: 1 },
      }),
    );
    expect((await app.deadLetters.list()).map(({ handler }) => handler)).toContain(
      "customer.followCalls",
    );
    await app.unrestrict("ana", { notice: "given" });
    await app.runUntilIdle();
    expect(followed).toEqual(["ana"]);
    await app.stop();
  });

  it("holds a deadline whose state names a restricted person, and hands the state a forgetting kept as null but to a process that names legal-obligation", async () => {
    const { app, clock, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await register("bo");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    await commands.issueInvoice?.({ customerId: "bo", invoiceId: "i-2", address: "2 Main St" });
    await app.runUntilIdle();
    await app.forget("ana");
    await app.restrict("bo", { ground: "legal-claims" });
    clock.advance(3_600_000);
    await app.runUntilIdle();
    expect(reminded).toEqual([null]);
    expect(recalled).toEqual(["1 Main St"]);
    expect(
      (await app.deadLetters.list())
        .filter(({ person }) => person === "bo")
        .map(({ handler }) => handler)
        .sort(),
    ).toEqual(expect.arrayContaining(["customer.recallInvoices", "customer.remindInvoices"]));
    await app.stop();
  });

  it("hands a policy, a process and a command what a forgetting kept as null, but for one that names legal-obligation", async () => {
    const { app, commands, register, accesses } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    accesses.length = 0;
    await app.runUntilIdle();
    expect(archived).toEqual(["1 Main St"]);
    expect(accesses.filter(({ operation }) => operation !== "query")).toEqual([]);
    for (const seen of [addresses, archived, filed, audited]) seen.length = 0;
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-2", address: "1 Main St" });
    await app.forget("ana");
    await app.runUntilIdle();
    expect(addresses).toEqual([null]);
    expect(archived).toEqual(["1 Main St"]);
    expect(filed).toEqual([null]);
    expect(audited).toEqual(["1 Main St"]);
    await commands.printInvoice?.({ customerId: "ana" });
    await commands.printInvoice?.({ customerId: "ana" }, { processRestricted: "legal-obligation" });
    expect(printed).toEqual([null, "1 Main St"]);
    await app.stop();
  });

  it("marks what a restriction covers in the export, the restricted records still in it", async () => {
    const { app, commands, register } = await setup({ adapter: adapterOf() });
    await register("ana");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "legal-claims", categories: ["invoices"] });
    const exported = await app.exportPersonalData("ana");
    expect(exported.restrictions).toEqual([
      { ground: "legal-claims", categories: ["invoices"], since: expect.any(String) },
    ]);
    const issued = exported.events.find((event) => event.type === "InvoiceIssued");
    expect(issued).toMatchObject({ data: { address: "1 Main St" }, restricted: ["address"] });
    const registered = exported.events.find((event) => event.type === "CustomerRegistered");
    expect(registered?.restricted).toEqual([]);
    expect(exported.readModels.invoices).toMatchObject([
      { key: "i-1", data: { address: "1 Main St" }, restricted: ["address"] },
    ]);
    await app.stop();
  });
});

describe("restriction of processing in a read model's own database", () => {
  it("keeps a copy of who is restricted beside the read model, which its queries filter by", async () => {
    const invoicesOn = createNodeSqliteAdapter().adapter;
    const { app, queries, commands, register } = await setup({
      adapter: createNodeSqliteAdapter().adapter,
      invoicesOn,
    });
    await register("ana");
    await commands.issueInvoice?.({ customerId: "ana", invoiceId: "i-1", address: "1 Main St" });
    await app.runUntilIdle();
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual(["i-1"]);
    await app.catchUpReadModels({
      through: await app.restrict("ana", { ground: "accuracy-contested" }),
    });
    expect(await queries.invoicesOf?.({ customerId: "ana" })).toEqual([]);
    const tables = (await invoicesOn.inspect()).map(({ name }) => name);
    expect(tables).toContain("bounda_restricted_persons");
    await app.stop();
  });
});

describe("restriction of processing through SQL a query writes", () => {
  it("drops the restricted rows the client reads, and refuses a row with personal fields and no person", async () => {
    const { app, queries, register } = await setup({ adapter: createNodeSqliteAdapter().adapter });
    for (const customer of ["ana", "bo"]) await register(customer);
    await app.runUntilIdle();
    await app.restrict("ana", { ground: "accuracy-contested" });
    await app.catchUpReadModels();
    expect(await queries.bySql?.()).toEqual(["bo"]);
    expect(await queries.bySql?.(undefined, { includeRestricted: "consent" })).toEqual([
      "ana",
      "bo",
    ]);
    await expect(queries.emailsBySql?.()).rejects.toThrow(
      'A query of read model "customers" read a field marked .personal() through client without "customerId"',
    );
    await app.stop();
  });
});

describe("a policy that names a basis that is none", () => {
  it("keeps the app from starting", async () => {
    const registry = registryWith({ reportBasis: "curiosity" as RestrictionBasis });
    await expect(createTestApp({ registry })).rejects.toThrow(
      'aggregates.customer.policies.reportOnCustomerRegistered: restricted "curiosity" is not a basis of article 18(2); use one of "consent", "legal-claims", "protection-of-rights", "public-interest", "legal-obligation"',
    );
  });
});
