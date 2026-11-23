import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Adapter, Storage } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConfigurationError, PROCESSING_RESTRICTED } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { createSequentialIdGenerator } from "../../contracts/ids.ts";
import { type Logger, silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { NotifiedRecipient, RecipientDeclaration } from "../../modules/recipient.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp } from "../../testing/index.ts";
import { type BoundaApp, createApp } from "../app.ts";
import { defineForgetLedger } from "../personal-data/forget-ledger.ts";
import { masterKey } from "../personal-data/master-key.ts";
import { FORGET_LEDGER_GRACE_MS } from "../personal-data/reconciliation.ts";
import { defineTenantKeyStore } from "../personal-data/tenant-key-source.ts";
import { RESTORE_MARK } from "../shared/restores.ts";
import { installFakeTelemetry } from "../telemetry-fake.ts";
import { readPart } from "../test-support.ts";

type Events = Record<string, (payload?: unknown) => unknown>;

interface Notice {
  readonly port: string;
  readonly type: string;
  readonly person: string;
  readonly categories: readonly string[];
  readonly retained?: readonly string[];
  readonly presumed: boolean;
  readonly idempotencyKey: string;
  readonly persons?: readonly string[];
}

interface Sender {
  send(args: { readonly to: string | null }): Promise<void>;
}

interface CustomerRow {
  readonly customerId: string;
  readonly email?: string;
}

const START = new Date("2026-03-01T00:00:00.000Z");

// One recipient module whose handlers record what they are told, in `told`, and fail while
// `failing` names their port.
const recipientModule = (
  port: string,
  recipient: RecipientDeclaration<string>,
  told: Notice[],
  failing: Set<string>,
) => {
  const handler =
    (type: string) =>
    async ({
      event,
      categories,
      retained,
      presumed,
      idempotencyKey,
      persons,
    }: {
      event: StoredEvent;
      categories: readonly string[];
      retained?: readonly string[];
      presumed: boolean;
      idempotencyKey: string;
      persons?: () => AsyncIterable<string>;
    }) => {
      if (failing.has(port)) throw new Error(`${port} is down`);
      const listed: string[] = [];
      if (persons !== undefined) for await (const person of persons()) listed.push(person);
      told.push({
        port,
        type,
        person: event.aggregateId,
        categories,
        ...(retained === undefined ? {} : { retained }),
        presumed,
        idempotencyKey,
        ...(persons === undefined ? {} : { persons: listed }),
      });
    };
  return {
    recipient,
    onPersonalDataForgotten: handler("PersonalDataForgotten"),
    onProcessingRestricted: handler("ProcessingRestricted"),
    onProcessingRestrictionLiftAnnounced: handler("ProcessingRestrictionLiftAnnounced"),
    onProcessingRestrictionLifted: handler("ProcessingRestrictionLifted"),
    onPersonalDataRedacted: handler("PersonalDataRedacted"),
    onTenantForgotten: handler("TenantForgotten"),
  };
};

const MAILCHIMP: RecipientDeclaration<string> = {
  name: "Mailchimp",
  kind: "processor",
  country: "US",
  safeguard: "standard-contractual-clauses",
  categories: ["contact"],
};

const BREVO: RecipientDeclaration<string> = {
  name: "Brevo",
  kind: "third-party",
  country: "FR",
  categories: ["contact", "invoices"],
};

interface RegistryOptions {
  readonly told: Notice[];
  readonly failing?: Set<string>;
  readonly mailer?: RecipientDeclaration<string> | null;
  readonly crm?: RecipientDeclaration<string> | null;
  // The port name the mailer is declared under, for a rename.
  readonly mailerPort?: string;
  readonly drop?: ReadonlySet<string>;
}

const registryWith = ({
  told,
  failing = new Set(),
  mailer = MAILCHIMP,
  crm = BREVO,
  mailerPort = "mailer",
}: RegistryOptions): Registry => {
  const recipients: Record<string, unknown> = {};
  if (mailer !== null) {
    recipients[mailerPort] = recipientModule(`customer.${mailerPort}`, mailer, told, failing);
  }
  if (crm !== null) recipients.crm = recipientModule("customer.crm", crm, told, failing);
  return {
    personalData: {
      automatedDecisions: {},
      categories: {
        contact: {
          basis: "consent",
          retention: "730d",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
        invoices: {
          basis: "legal-obligation",
          retention: "6y",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      },
    },
    aggregates: {
      customer: {
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({
                email: personal(z.email(), { category: "contact" }),
                address: personal(z.string(), { category: "invoices" }).optional(),
              }),
            evolve: ({ event }: { event: { payload: object } }) => ({ ...event.payload }),
          },
          customerSynced: {
            payload: ({ z }: EventPayloadArgs) => z.object({}),
            evolve: ({ state }: { state: object }) => state,
          },
        },
        ports: {
          [mailerPort]: { memory: { default: {} } },
          crm: { memory: { default: {} } },
        },
        recipients,
        commands: {
          registerCustomer: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({
                  customerId: notPersonal(z.string()),
                  email: notPersonal(z.email()),
                  address: notPersonal(z.string().optional()),
                }),
              handler: ({
                command,
                events,
              }: {
                command: { payload: { email: string; address?: string } };
                events: Events;
              }) => [
                events.customerRegistered?.({
                  email: command.payload.email,
                  ...(command.payload.address === undefined
                    ? {}
                    : { address: command.payload.address }),
                }),
              ],
            },
          },
          // Hands the customer's invoicing address to the CRM, from the state it loaded.
          syncCustomer: {
            module: {
              payload: ({ z, notPersonal }: CommandPayloadArgs) =>
                z.object({ customerId: notPersonal(z.string()) }),
              handler: async ({
                state,
                events,
                crm: port,
              }: {
                state: { address?: string | null };
                events: Events;
                crm: Sender;
              }) => {
                await port.send({ to: state.address ?? null });
                return [events.customerSynced?.({})];
              },
            },
          },
        },
        policies: {
          welcomeOnCustomerRegistered: {
            module: {
              handler: async ({
                event,
                ...ports
              }: {
                event: { payload: { email: string | null } };
              } & Record<string, Sender>) => {
                await ports[mailerPort]?.send({ to: event.payload.email });
              },
            },
          },
          // Calls the mailer with nothing of anyone's: discloses nothing.
          pingOnCustomerSynced: {
            module: {
              handler: async (ports: Record<string, Sender>) => {
                await ports[mailerPort]?.send({ to: null });
              },
            },
          },
        },
        processes: {},
      },
    },
    readModels: {
      customers: {
        view: {
          fields: ({ f }: FieldsArgs) => ({
            customerId: f.string().primaryKey().person(),
            email: f.string().optional().personal({ category: "contact" }),
          }),
        },
        ports: { audience: { memory: { default: {} } } },
        recipients: {
          audience: recipientModule(
            "customers.audience",
            { name: "Audience", kind: "processor", country: "DE", categories: ["contact"] },
            told,
            failing,
          ),
        },
        projections: {
          customer: {
            customerRegistered: {
              project: ({
                event,
                table,
              }: {
                event: { aggregateId: string; payload: { email: string | null } };
                table: Table<CustomerRow>;
              }) =>
                table.upsert({
                  customerId: event.aggregateId,
                  ...(event.payload.email === null ? {} : { email: event.payload.email }),
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
          shareCustomer: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            repository: ({
              table,
              customerId,
            }: {
              table: Table<CustomerRow>;
              customerId: string;
            }) => table.findOne({ customerId }),
            handler: async ({
              repositoryData,
              audience,
            }: {
              repositoryData: CustomerRow | null;
              audience: Sender;
            }) => {
              await audience.send({ to: repositoryData?.email ?? null });
              return repositoryData;
            },
          },
        },
      },
    },
  } as unknown as Registry;
};

let starts = 0;

// The registry with each port's one implementation the double given, and its access log going to
// `onAccess`.
const registryWithDoubles = (
  registry: Registry,
  doubles: Readonly<Record<string, Readonly<Record<string, Sender>>>>,
  onAccess: (args: { readonly access: PersonalDataAccess }) => void,
): Registry => {
  const withPorts = <Entry extends { readonly ports?: object }>(name: string, entry: Entry) => ({
    ...entry,
    ports: Object.fromEntries(
      Object.keys(entry.ports ?? {}).map((port) => [
        port,
        { memory: { default: doubles[name]?.[port] } },
      ]),
    ),
  });
  return {
    ...registry,
    audit: { onPersonalDataAccess: onAccess },
    aggregates: Object.fromEntries(
      Object.entries(registry.aggregates).map(([name, entry]) => [name, withPorts(name, entry)]),
    ),
    readModels: Object.fromEntries(
      Object.entries(registry.readModels).map(([name, entry]) => [name, withPorts(name, entry)]),
    ),
  } as unknown as Registry;
};

const sender = (calls: (string | null)[]): Sender => ({
  send: async ({ to }) => {
    calls.push(to);
  },
});

interface StartArgs {
  readonly told?: Notice[];
  readonly failing?: Set<string>;
  readonly registry?: Registry;
  readonly adapter?: Adapter;
  readonly mailerPort?: string;
}

const start = async ({
  told = [],
  failing = new Set(),
  registry = registryWith({ told, failing }),
  adapter,
  mailerPort = "mailer",
}: StartArgs = {}) => {
  const mailed: (string | null)[] = [];
  const synced: (string | null)[] = [];
  const shared: (string | null)[] = [];
  const accesses: PersonalDataAccess[] = [];
  const ports = { [mailerPort]: sender(mailed), crm: sender(synced) };
  const onPersonalDataAccess = ({ access }: { access: PersonalDataAccess }) => {
    accesses.push(access);
  };
  // Apps that share a store each take ids of their own, as instances of one app do.
  const { app, clock } =
    adapter === undefined
      ? await createTestApp({
          registry,
          now: START,
          ports: { customer: ports, customers: { audience: sender(shared) } } as never,
          onPersonalDataAccess,
        })
      : await (async () => {
          starts += 1;
          const clock = createFixedClock(START);
          const app = await createApp({
            registry: registryWithDoubles(
              registry,
              { customer: ports, customers: { audience: sender(shared) } },
              onPersonalDataAccess,
            ),
            config: { storage: adapter, ports: {} } as never,
            clock,
            ids: createSequentialIdGenerator({ prefix: `app-${starts}` }),
            logger: silentLogger,
          });
          return { app, clock };
        })();
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: object) => Promise<unknown>
  >;
  const queries = app.queries as unknown as Record<string, (payload: unknown) => Promise<unknown>>;
  const register = async (customerId: string, address?: string): Promise<void> => {
    await commands.registerCustomer?.({
      customerId,
      email: `${customerId}@example.com`,
      ...(address === undefined ? {} : { address }),
    });
    await app.runUntilIdle();
  };
  const notified = async (type: string): Promise<readonly NotifiedRecipient[]> => {
    const events = (await app.events.read({ limit: 1000 })).filter((event) => event.type === type);
    return (
      (events.at(-1)?.payload as { recipients?: readonly NotifiedRecipient[] } | undefined)
        ?.recipients ?? []
    );
  };
  return {
    app,
    clock,
    commands,
    queries,
    register,
    notified,
    told,
    mailed,
    synced,
    shared,
    accesses,
  };
};

describe("recipients of personal data", () => {
  it("records what a policy hands a port of the categories its recipient receives, and tells it of a forgetting", async () => {
    const { app, register, notified, told, mailed, accesses } = await start();
    await register("c-1", "1 Main St");
    expect(mailed).toEqual(["c-1@example.com"]);
    const disclosed = accesses.filter((access) => access.operation === "disclosure");
    expect(disclosed).toEqual([
      expect.objectContaining({
        operation: "disclosure",
        persons: ["c-1"],
        detail: {
          recipient: "customer.mailer",
          handler: "customer.welcomeOnCustomerRegistered",
          categories: ["contact"],
        },
        outcome: "ok",
        restricted: null,
      }),
    ]);
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(await notified("PersonalDataForgotten")).toEqual([
      { port: "customer.mailer", categories: ["contact"], retained: [], presumed: false },
    ]);
    expect(told).toEqual([
      {
        port: "customer.mailer",
        type: "PersonalDataForgotten",
        person: "c-1",
        categories: ["contact"],
        retained: [],
        presumed: false,
        idempotencyKey: expect.any(String),
      },
    ]);
    expect(accesses.filter((access) => access.operation === "recipientNotice")).toEqual([
      expect.objectContaining({
        persons: ["c-1"],
        outcome: "ok",
        detail: expect.objectContaining({
          recipient: "customer.mailer",
          event: "PersonalDataForgotten",
          categories: ["contact"],
          superseded: false,
        }),
      }),
    ]);
  });

  it("records nothing for a call that hands out nothing anyone's, and tells nobody it did not reach", async () => {
    const { app, commands, register, notified, mailed, synced, accesses } = await start();
    await register("c-1");
    await register("c-2");
    await commands.syncCustomer?.({ customerId: "c-1" });
    await app.runUntilIdle();
    expect(synced).toEqual([null]);
    expect(mailed).toEqual(["c-1@example.com", "c-2@example.com", null]);
    // The command read the customer's contact, which the CRM receives: whatever it handed over,
    // it may have been that. The ping after it read nothing of anyone's.
    expect(
      accesses
        .filter((access) => access.operation === "disclosure")
        .map(({ persons, detail }) => [persons, (detail as { recipient: string }).recipient]),
    ).toEqual([
      [["c-1"], "customer.mailer"],
      [["c-2"], "customer.mailer"],
      [["c-1"], "customer.crm"],
    ]);
    expect((await app.recipientsOf("c-2")).map(({ port, status }) => [port, status])).toEqual([
      ["customer.crm", "declared"],
      ["customer.mailer", "disclosed"],
      ["customers.audience", "declared"],
    ]);
    await app.forget("c-2");
    await app.runUntilIdle();
    expect((await notified("PersonalDataForgotten")).map(({ port }) => port)).toEqual([
      "customer.mailer",
    ]);
  });

  it("records what is handed to a port that is a function itself", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      policies: Record<string, { module: { handler: (args: never) => unknown } }>;
    };
    customer.policies.welcomeOnCustomerRegistered = {
      module: {
        handler: async ({
          event,
          mailer,
        }: {
          event: { payload: { email: string | null } };
          mailer: (to: string | null) => Promise<void>;
        }) => {
          await mailer(event.payload.email);
        },
      },
    };
    const called: (string | null)[] = [];
    const { app, commands, notified } = await (async () => {
      const started = await createTestApp({
        registry,
        now: START,
        ports: {
          customer: {
            mailer: async (to: string | null) => void called.push(to),
            crm: sender([]),
          },
          customers: { audience: sender([]) },
        } as never,
      });
      return {
        app: started.app,
        commands: started.app.commands as unknown as Record<
          string,
          (payload: unknown) => Promise<unknown>
        >,
        notified: async () =>
          (
            (await started.app.events.read({ limit: 100 })).find(
              (event) => event.type === "PersonalDataForgotten",
            )?.payload as { recipients?: readonly NotifiedRecipient[] } | undefined
          )?.recipients ?? [],
      };
    })();
    await commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
    await app.runUntilIdle();
    expect(called).toEqual(["c-1@example.com"]);
    await app.forget("c-1");
    await app.runUntilIdle();
    expect((await notified()).map(({ port }) => port)).toEqual(["customer.mailer"]);
  });

  it("records what a command hands a port from the state it loaded", async () => {
    const { app, commands, register, notified, synced } = await start();
    await register("c-1", "1 Main St");
    await commands.syncCustomer?.({ customerId: "c-1" });
    expect(synced).toEqual(["1 Main St"]);
    await app.forget("c-1", { categories: ["invoices"] });
    await app.runUntilIdle();
    expect(await notified("PersonalDataForgotten")).toEqual([
      { port: "customer.crm", categories: [], retained: ["invoices"], presumed: false },
    ]);
    // Invoices are kept under a legal obligation: the recipient restricts them.
    const [forgotten] = (await app.events.read({ limit: 100 })).filter(
      (event) => event.type === "PersonalDataForgotten",
    );
    expect(forgotten?.payload).toMatchObject({ retained: ["invoices"] });
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(await notified("PersonalDataForgotten")).toEqual([
      { port: "customer.crm", categories: ["contact"], retained: ["invoices"], presumed: false },
      { port: "customer.mailer", categories: ["contact"], retained: [], presumed: false },
    ]);
  });

  it("tells every recipient once the tenant is forgotten, with every person disclosed to it, and runs nothing else", async () => {
    const failing = new Set<string>();
    const told: Notice[] = [];
    const { app, register, mailed, synced } = await start({ told, failing });
    await register("c-1", "1 Main St");
    await register("c-2");
    told.length = 0;
    mailed.length = 0;
    // The mailer is down: its notice waits as a dead letter of the forgotten app. A forgetting
    // of a person still to tell goes untold: the tenant's tells the same recipients more.
    failing.add("customer.mailer");
    await app.forget("c-2");
    const { eventId } = await app.forgetTenant("default", { despiteLegalObligations: true });
    await app.runUntilIdle();
    expect(mailed).toEqual([]);
    expect(synced).toEqual([]);
    expect(told).toEqual([]);
    const letters = await app.deadLetters.list({ kind: "recipient" });
    expect(letters).toMatchObject([
      { handler: "customer.mailer", eventId, eventType: "TenantForgotten", person: null },
    ]);
    failing.clear();
    await app.deadLetters.retry(letters[0]?.id ?? "");
    // Only the recipients disclosed data are told: the CRM received nothing of the tenant.
    expect(told).toEqual([
      {
        port: "customer.mailer",
        type: "TenantForgotten",
        person: "default",
        categories: ["contact"],
        presumed: false,
        idempotencyKey: expect.any(String),
        persons: ["c-1"],
      },
    ]);
    await expect(app.deadLetters.retry(letters[0]?.id ?? "")).rejects.toMatchObject({
      code: "DEAD_LETTER_SETTLED",
    });
    await app.runUntilIdle();
    expect((await app.getLag()).maxLag).toBe(0);
  });

  it("tells a recipient of a restriction, of its lift announced and of the lift, and of a redaction", async () => {
    const { app, clock, register, told } = await start();
    await register("c-1");
    await app.restrict("c-1", { ground: "accuracy-contested", categories: ["contact"] });
    await app.unrestrict("c-1", { notice: "1d" });
    await app.runUntilIdle();
    clock.advance(86_400_000);
    await app.runUntilIdle();
    const [registered] = (await app.exportPersonalData("c-1")).events;
    await app.redact("c-1", {
      events: [{ ...(registered as object), fields: ["email"] }],
    } as never);
    await app.runUntilIdle();
    expect(told.map(({ type, categories }) => [type, categories])).toEqual([
      ["ProcessingRestricted", ["contact"]],
      ["ProcessingRestrictionLiftAnnounced", ["contact"]],
      ["ProcessingRestrictionLifted", ["contact"]],
      ["PersonalDataRedacted", ["contact"]],
    ]);
  });

  it("tells nobody of a restriction of a category no recipient received", async () => {
    const { app, register, notified } = await start();
    await register("c-1");
    await app.restrict("c-1", { ground: "unlawful-processing", categories: ["invoices"] });
    await app.runUntilIdle();
    expect(await notified("ProcessingRestricted")).toEqual([]);
  });

  it("refuses to hand a port data of a person restricted since it was read, and hands what is read again", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const { app, register, commands, synced, accesses } = await start({ told, registry });
    await register("c-1", "1 Main St");
    await app.restrict("c-1", { ground: "legal-claims" });
    await expect(commands.syncCustomer?.({ customerId: "c-1" })).rejects.toMatchObject({
      code: PROCESSING_RESTRICTED,
    });
    expect(synced).toEqual([]);
    await commands.syncCustomer?.({ customerId: "c-1" }, { processRestricted: "legal-claims" });
    expect(synced).toEqual(["1 Main St"]);
    expect(accesses.filter((access) => access.operation === "disclosure").at(-1)).toMatchObject({
      restricted: { basis: "legal-claims", persons: ["c-1"] },
    });
  });

  it("lists what a query hands a read model's port, as of the read model's checkpoint", async () => {
    const { app, queries, register, shared, notified } = await start();
    await register("c-1");
    await queries.shareCustomer?.({ customerId: "c-1" });
    expect(shared).toEqual(["c-1@example.com"]);
    await app.forget("c-1");
    await app.runUntilIdle();
    expect((await notified("PersonalDataForgotten")).map(({ port }) => port)).toEqual([
      "customer.mailer",
      "customers.audience",
    ]);
  });

  it("retries a recipient that fails, files a dead letter once its attempts run out, and tells it again on retry", async () => {
    const failing = new Set(["customer.mailer"]);
    const { app, register, told } = await start({ failing });
    await register("c-1");
    await app.restrict("c-1", { ground: "legal-claims" });
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      kind: "recipient",
      handler: "customer.mailer",
      eventType: "ProcessingRestricted",
      person: "c-1",
      status: "failed",
    });
    failing.clear();
    const telemetry = installFakeTelemetry();
    try {
      await app.deadLetters.retry(letter?.id as string);
      expect(
        telemetry.spans.find(({ name }) => name === "bounda.recipient customer.mailer")?.attributes[
          "bounda.attempt"
        ],
      ).toBe((letter?.attempts ?? 0) + 1);
    } finally {
      telemetry.restore();
    }
    expect(told.map(({ type }) => type)).toEqual(["ProcessingRestricted"]);
  });

  it("keeps a notice's dead letter past a forgetting, and does not tell what the forgetting superseded", async () => {
    const failing = new Set(["customer.mailer"]);
    const { app, register, told, accesses } = await start({ failing });
    await register("c-1");
    await app.restrict("c-1", { ground: "legal-claims" });
    await app.runUntilIdle();
    failing.clear();
    await app.forget("c-1");
    await app.runUntilIdle();
    expect(told.map(({ type }) => type)).toEqual(["PersonalDataForgotten"]);
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({ kind: "recipient", status: "failed" });
    await app.deadLetters.retry(letter?.id as string);
    expect(told.map(({ type }) => type)).toEqual(["PersonalDataForgotten"]);
    expect(
      accesses.filter((access) => access.operation === "recipientNotice").at(-1)?.detail,
    ).toMatchObject({ event: "ProcessingRestricted", superseded: true });
  });

  it("tells the port that took a renamed one over, and files a letter for a port no longer declared", async () => {
    const adapter = memory();
    const told: Notice[] = [];
    const first = await start({ told, adapter });
    await first.register("c-1");
    await first.register("c-2");
    await first.app.stop();
    const renamed = await start({
      told,
      adapter,
      mailerPort: "newsletter",
      registry: registryWith({
        told,
        mailerPort: "newsletter",
        mailer: { ...MAILCHIMP, formerly: ["customer.mailer"] },
      }),
    });
    await renamed.app.forget("c-1");
    await renamed.app.runUntilIdle();
    expect(told.map(({ port, person }) => [port, person])).toEqual([
      ["customer.newsletter", "c-1"],
    ]);
    await renamed.app.stop();
    const removed = await start({ told, adapter, registry: registryWith({ told, mailer: null }) });
    await removed.app.forget("c-2");
    await removed.app.runUntilIdle();
    const letters = await removed.app.deadLetters.list();
    expect(letters).toEqual([
      expect.objectContaining({
        kind: "recipient",
        handler: "customer.newsletter",
        errorName: "ConfigurationError",
        errorType: "terminal",
      }),
    ]);
    expect(
      (await removed.app.recipientsOf("c-2")).find(({ port }) => port === "customer.newsletter"),
    ).toBeUndefined();
  });

  it("presumes a recipient declared after a person's data existed holds it, until told to forget it", async () => {
    const adapter = memory();
    const told: Notice[] = [];
    const before = await start({
      told,
      adapter,
      registry: registryWith({ told, mailer: null, crm: null }),
    });
    await before.register("c-1");
    await before.app.stop();
    const after = await start({ told, adapter });
    await after.register("c-2");
    // The read model's port was declared all along, and was never called.
    expect((await after.app.recipientsOf("c-1")).map(({ port, status }) => [port, status])).toEqual(
      [
        ["customer.crm", "presumed"],
        ["customer.mailer", "presumed"],
        ["customers.audience", "declared"],
      ],
    );
    await after.app.restrict("c-2", { ground: "legal-claims" });
    await after.app.forget("c-1", { categories: ["contact"] });
    await after.app.runUntilIdle();
    expect(told.map(({ port, person, presumed }) => [port, person, presumed])).toEqual([
      ["customer.mailer", "c-2", false],
      ["customer.crm", "c-1", true],
      ["customer.mailer", "c-1", true],
    ]);
    expect(await after.app.recipientsOf("c-1")).toEqual([]);
  });

  it("tells the recipients of a forgotten tenant each port it disclosed to or may have, presumed or not", async () => {
    const adapter = memory();
    const told: Notice[] = [];
    const before = await start({
      told,
      adapter,
      registry: registryWith({ told, mailer: null, crm: null }),
    });
    await before.register("c-1");
    await before.app.stop();
    const after = await start({ told, adapter });
    await after.register("c-2");
    await after.app.runUntilIdle();
    // More persons than one page of persons() holds.
    const storage = await adapter.createStorage();
    const many = Array.from({ length: 600 }, (_, index) => `m-${String(index).padStart(3, "0")}`);
    await storage.recipients.disclose(
      many.map((person) => ({
        person,
        port: "customer.mailer",
        recipient: "Mailchimp",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        category: "contact",
      })),
      START.toISOString(),
    );
    told.length = 0;
    after.accesses.length = 0;
    await after.app.forgetTenant("default", { despiteLegalObligations: true });
    await after.app.runUntilIdle();
    // The tenant's notice is about no one person.
    expect(
      after.accesses
        .filter(({ operation }) => operation === "recipientNotice")
        .map(({ persons }) => persons),
    ).toEqual([[], []]);
    expect(
      told.map(({ port, type, categories, presumed, persons }) => [
        port,
        type,
        categories,
        presumed,
        persons,
      ]),
    ).toEqual([
      ["customer.crm", "TenantForgotten", ["contact", "invoices"], true, []],
      // Presumed to hold c-1's, which no disclosure recorded, besides those it was disclosed.
      ["customer.mailer", "TenantForgotten", ["contact"], true, ["c-2", ...many].sort()],
    ]);
  });

  it("tells a recipient declared late, presumed and in order, what was forgotten, restricted or redacted before", async () => {
    const adapter = memory();
    const told: Notice[] = [];
    const before = await start({
      told,
      adapter,
      registry: registryWith({ told, mailer: null, crm: null }),
    });
    await before.register("c-1");
    await before.register("c-2");
    await before.app.forget("c-1");
    await before.app.restrict("c-2", { ground: "legal-claims", categories: ["contact"] });
    await before.app.restrict("c-2", { ground: "unlawful-processing", categories: ["invoices"] });
    await before.app.runUntilIdle();
    await before.app.stop();
    const failing = new Set(["customer.mailer"]);
    const after = await start({ told, failing, adapter });
    await after.app.unrestrict("c-2", { notice: "given" });
    await after.app.runUntilIdle();
    // The mailer fails: it holds its catch-up, and every later notice waits behind it.
    expect(told.map(({ port, type, person }) => [port, type, person])).toEqual([
      ["customer.crm", "PersonalDataForgotten", "c-1"],
      ["customer.crm", "ProcessingRestricted", "c-2"],
      ["customer.crm", "ProcessingRestricted", "c-2"],
      ["customer.crm", "ProcessingRestrictionLifted", "c-2"],
    ]);
    expect(told.slice(0, 3).map(({ presumed, categories }) => [presumed, categories])).toEqual([
      [true, ["contact", "invoices"]],
      [true, ["contact"]],
      [true, ["invoices"]],
    ]);
    // Its notices wait for their retry, the later ones behind the first.
    expect(await after.app.deadLetters.list()).toEqual([]);
    failing.clear();
    after.clock.advance(86_400_000);
    await after.app.runUntilIdle();
    expect(told.slice(4).map(({ port, type, person }) => [port, type, person])).toEqual([
      ["customer.mailer", "PersonalDataForgotten", "c-1"],
      ["customer.mailer", "ProcessingRestricted", "c-2"],
      ["customer.mailer", "ProcessingRestrictionLifted", "c-2"],
    ]);
  });

  it("refuses a disclosure of data the person's stream moved past since it was read", async () => {
    const told: Notice[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reach: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let waited = false;
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      policies: Record<string, { module: { handler: (args: never) => unknown } }>;
    };
    customer.policies.welcomeOnCustomerRegistered = {
      module: {
        handler: async ({
          event,
          mailer,
        }: {
          event: { payload: { email: string | null } };
          mailer: Sender;
        }) => {
          if (!waited) {
            waited = true;
            reach();
            await held;
          }
          await mailer.send({ to: event.payload.email });
        },
      },
    };
    const { app, commands, mailed, notified } = await start({ told, registry });
    await commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
    const running = app.runUntilIdle();
    await reached;
    await app.forget("c-1");
    release();
    await running;
    await app.runUntilIdle();
    expect(mailed).toEqual([null]);
    expect(await notified("PersonalDataForgotten")).toEqual([]);
  });

  it("presumes, without a forget ledger, every recipient holds what existed when the database went back", async () => {
    const { app, register, notified } = await start();
    await register("c-1");
    await app.restored();
    await app.forget("c-1");
    await app.runUntilIdle();
    // Presumed, a recipient is told of every category it declares that the change touches.
    expect(await notified("PersonalDataForgotten")).toEqual([
      { port: "customer.crm", categories: ["contact", "invoices"], retained: [], presumed: true },
      { port: "customer.mailer", categories: ["contact"], retained: [], presumed: false },
      { port: "customers.audience", categories: ["contact"], retained: [], presumed: true },
    ]);
  });

  it("records what a process step hands a port from the event and the state it read", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      processes: Record<string, unknown>;
    };
    customer.processes.onboarding = {
      module: {
        config: ({ events }: { events: { customer: { CustomerRegistered: unknown } } }) => ({
          startedBy: [events.customer.CustomerRegistered],
          timeout: "30d",
        }),
      },
      handlers: {
        customer: {
          customerRegistered: {
            handler: async ({
              event,
              crm,
            }: {
              event: { payload: { address?: string | null } };
              crm: Sender;
            }) => {
              await crm.send({ to: event.payload.address ?? null });
            },
          },
        },
      },
    };
    const { app, register, synced, accesses } = await start({ told, registry });
    await register("c-1", "1 Main St");
    expect(synced).toEqual(["1 Main St"]);
    expect(
      accesses.filter((access) => access.operation === "disclosure").map(({ detail }) => detail),
    ).toContainEqual({
      recipient: "customer.crm",
      handler: "customer.onboarding",
      categories: ["contact", "invoices"],
    });
    await app.stop();
  });

  it("checks every call of a run again, so a second call after a forgetting is refused", async () => {
    const told: Notice[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reach: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    let calls = 0;
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      policies: Record<string, { module: { handler: (args: never) => unknown } }>;
    };
    customer.policies.welcomeOnCustomerRegistered = {
      module: {
        handler: async ({
          event,
          mailer,
        }: {
          event: { payload: { email: string | null } };
          mailer: Sender;
        }) => {
          await mailer.send({ to: event.payload.email });
          calls += 1;
          if (calls === 1) {
            reach();
            await held;
          }
          await mailer.send({ to: event.payload.email });
        },
      },
    };
    const { app, commands, mailed } = await start({ told, registry });
    await commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
    const running = app.runUntilIdle();
    await reached;
    await app.forget("c-1");
    release();
    await running;
    await app.runUntilIdle();
    // The first call went before the forgetting, and told it; the second was refused, and the
    // run tried again on what is left.
    expect(mailed).toEqual(["c-1@example.com", null, null]);
    expect(told.map(({ type, person }) => [type, person])).toEqual([
      ["PersonalDataForgotten", "c-1"],
    ]);
  });

  it("decides a command again when what it read changed before its port was called", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    let app: Awaited<ReturnType<typeof start>>["app"] | undefined;
    let changes = 0;
    const customer = registry.aggregates.customer as unknown as {
      commands: Record<string, { module: Record<string, unknown> }>;
    };
    const sync = customer.commands.syncCustomer?.module ?? {};
    customer.commands.syncCustomer = {
      module: {
        ...sync,
        handler: async ({
          state,
          events,
          crm,
        }: {
          state: { address?: string | null };
          events: Events;
          crm: Sender;
        }) => {
          if (changes === 0) {
            changes += 1;
            await app?.restrict("c-1", { ground: "legal-claims", categories: ["invoices"] });
          }
          await crm.send({ to: state.address ?? null });
          return [events.customerSynced?.({})];
        },
      },
    };
    const started = await start({ told, registry });
    app = started.app;
    await started.register("c-1");
    await started.commands.syncCustomer?.({ customerId: "c-1" });
    expect(started.synced).toEqual([null]);
  });

  it("lets a policy or a process that names a basis disclose restricted data, recorded with it", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      policies: Record<string, { module: Record<string, unknown> }>;
      processes: Record<string, unknown>;
    };
    const sendAddress = async ({
      event,
      crm,
    }: {
      event: { payload: { address?: string | null } };
      crm: Sender;
    }) => {
      await crm.send({ to: event.payload.address ?? null });
    };
    customer.policies.welcomeOnCustomerRegistered = { module: { handler: async () => {} } };
    customer.policies.syncOnCustomerRegistered = {
      module: { restricted: "legal-claims", handler: sendAddress },
    };
    customer.processes.archive = {
      module: {
        config: ({ events }: { events: { customer: { CustomerRegistered: unknown } } }) => ({
          startedBy: [events.customer.CustomerRegistered],
          timeout: "30d",
        }),
        restricted: "legal-claims",
      },
      handlers: { customer: { customerRegistered: { handler: sendAddress } } },
    };
    const { app, commands, synced, accesses } = await start({ told, registry });
    await commands.registerCustomer?.({
      customerId: "c-1",
      email: "c-1@example.com",
      address: "1 Main St",
    });
    await app.restrict("c-1", { ground: "legal-claims" });
    await app.runUntilIdle();
    expect(synced).toEqual(["1 Main St", "1 Main St"]);
    expect(
      accesses
        .filter((access) => access.operation === "disclosure")
        .map(({ detail, restricted }) => [(detail as { handler: string }).handler, restricted]),
    ).toEqual([
      [
        "customer.syncOnCustomerRegistered",
        { basis: "legal-claims", persons: ["c-1"], personCount: 1 },
      ],
      ["customer.archive", { basis: "legal-claims", persons: ["c-1"], personCount: 1 }],
    ]);
  });

  it("refuses what a query hands a port while its read model has not caught up with a change of the person", async () => {
    const { app, queries, register, shared } = await start();
    await register("c-1");
    const [registered] = (await app.exportPersonalData("c-1")).events;
    await app.redact("c-1", {
      events: [{ ...(registered as object), fields: ["email"] }],
    } as never);
    await expect(queries.shareCustomer?.({ customerId: "c-1" })).rejects.toMatchObject({
      code: "CONCURRENCY_CONFLICT",
      streamId: "bounda:c-1",
    });
    expect(shared).toEqual([]);
    await app.runUntilIdle();
    await queries.shareCustomer?.({ customerId: "c-1" });
    expect(shared).toEqual([null]);
  });

  it("hands what a query reads while its read model rests behind a change of the person it does not handle", async () => {
    const { app, queries, register, shared } = await start();
    await register("c-1");
    await app.restrict("c-1", { ground: "unlawful-processing", categories: ["invoices"] });
    await queries.shareCustomer?.({ customerId: "c-1" });
    expect(shared).toEqual(["c-1@example.com"]);
  });

  it("reports every recipient in the app's status", async () => {
    const { app, register } = await start();
    await register("c-1");
    expect(
      readPart((await app.status()).recipients).map(({ port, persons }) => [port, persons]),
    ).toEqual([
      ["customer.crm", 0],
      ["customer.mailer", 1],
      ["customers.audience", 0],
    ]);
  });

  it("lists every recipient in the export, with the category's basis and the transfer's safeguard", async () => {
    const { app, register } = await start();
    await register("c-1");
    const { recipients } = await app.exportPersonalData("c-1");
    expect(recipients).toEqual([
      {
        port: "customer.crm",
        name: "Brevo",
        kind: "third-party",
        country: "FR",
        transfer: null,
        status: "declared",
        categories: [{ name: "contact", basis: "consent" }],
        firstDisclosedAt: null,
        lastDisclosedAt: null,
        declared: true,
      },
      {
        port: "customer.mailer",
        name: "Mailchimp",
        kind: "processor",
        country: "US",
        transfer: { safeguard: "standard-contractual-clauses" },
        status: "disclosed",
        categories: [{ name: "contact", basis: "consent" }],
        firstDisclosedAt: START.toISOString(),
        lastDisclosedAt: START.toISOString(),
        declared: true,
      },
      {
        port: "customers.audience",
        name: "Audience",
        kind: "processor",
        country: "DE",
        transfer: null,
        status: "declared",
        categories: [{ name: "contact", basis: "consent" }],
        firstDisclosedAt: null,
        lastDisclosedAt: null,
        declared: true,
      },
    ]);
  });

  it("records recipientsOf in the access log, and refuses an empty id", async () => {
    const { app, register, accesses } = await start();
    await register("c-1");
    await app.recipientsOf("c-1");
    expect(accesses.at(-1)).toMatchObject({
      operation: "recipientsOf",
      persons: ["c-1"],
      detail: { recipients: 3 },
      outcome: "ok",
    });
    await expect(app.recipientsOf("")).rejects.toThrow("recipientsOf needs the id of the person");
  });

  it("records a recipientsOf that fails with no count", async () => {
    const base = memory();
    const down = new Error("disclosures unavailable");
    const adapter: Adapter = {
      ...base,
      createStorage: async () => {
        const storage = await base.createStorage();
        return {
          ...storage,
          recipients: {
            ...storage.recipients,
            disclosures: async () => {
              throw down;
            },
          },
        };
      },
    };
    const { app, accesses } = await start({ adapter });
    await expect(app.recipientsOf("c-1")).rejects.toBe(down);
    expect(accesses.at(-1)).toMatchObject({
      operation: "recipientsOf",
      persons: ["c-1"],
      detail: null,
      outcome: "failed",
      errorName: "Error",
      errorCode: null,
    });
    await app.stop();
  });
});

describe("recipients and the forget ledger", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  const startWithLedger = async (
    storage: Adapter,
    ledger: Adapter,
    told: Notice[],
    logger: Logger = silentLogger,
  ) => {
    const app = await createApp({
      registry: registryWith({ told }),
      config: {
        storage,
        ports: {},
        runtime: { personalData: { forgetLedger: { store: ledger } } },
      } as never,
      clock: createFixedClock(START),
      ids: createSequentialIdGenerator({ prefix: `app-${stops.length}` }),
      logger,
    });
    stops.push(() => app.stop());
    return app;
  };

  it("has a disclosure in the ledger before the port is called", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const ledger = await ledgerAdapter.createForgetLedger({});
    const seen: (readonly ForgetLedgerEntry[])[] = [];
    const registry = registryWithDoubles(
      registryWith({ told: [] }),
      {
        customer: {
          mailer: {
            send: async () => {
              seen.push(await ledger.read({ limit: 10 }));
            },
          },
          crm: sender([]),
        },
        customers: { audience: sender([]) },
      },
      () => {},
    );
    const app = await createApp({
      registry,
      config: {
        storage,
        ports: {},
        runtime: { personalData: { forgetLedger: { store: ledgerAdapter } } },
      } as never,
      clock: createFixedClock(START),
      ids: createSequentialIdGenerator({ prefix: "ledgered" }),
    });
    stops.push(() => app.stop());
    const commands = app.commands as unknown as Record<
      string,
      (payload: unknown) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
    await app.runUntilIdle();
    expect(seen).toEqual([
      [
        expect.objectContaining({
          personId: "c-1",
          disclosure: expect.objectContaining({ port: "customer.mailer", category: "contact" }),
        }),
      ],
    ]);
  });

  it("keeps each disclosure in the ledger, and records again at start one the store lost", async () => {
    const storage = memory();
    const ledgerAdapter = memory();
    const told: Notice[] = [];
    const lost = new Date(START.getTime() - FORGET_LEDGER_GRACE_MS - 60_000).toISOString();
    const ledger = await ledgerAdapter.createForgetLedger({});
    const entry: ForgetLedgerEntry = {
      personId: "c-9",
      categories: null,
      eventId: "lost-disclosure",
      forgottenAt: lost,
      reason: "requested",
      disclosure: {
        port: "customer.mailer",
        recipient: "Mailchimp",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        category: "contact",
      },
    };
    await ledger.append([entry]);
    const logged: unknown[] = [];
    const app = await startWithLedger(storage, ledgerAdapter, told, {
      ...silentLogger,
      info: (message, fields) => {
        logged.push([message, fields]);
      },
    });
    expect(logged).toContainEqual([
      "disclosure recorded again from the forget ledger",
      { personId: "c-9", port: "customer.mailer" },
    ]);
    expect(await app.forgetAgain([entry])).toEqual([]);
    expect(
      (await app.recipientsOf("c-9")).map(({ port, status, firstDisclosedAt }) => [
        port,
        status,
        firstDisclosedAt,
      ]),
    ).toEqual([["customer.mailer", "disclosed", lost]]);
    await app.forget("c-9");
    await app.runUntilIdle();
    expect(told.map(({ port, person }) => [port, person])).toEqual([["customer.mailer", "c-9"]]);
  });

  it("presumes nothing after a restore when the ledger keeps every disclosure", async () => {
    const app = await startWithLedger(memory(), memory(), []);
    const commands = app.commands as unknown as Record<
      string,
      (payload: unknown) => Promise<unknown>
    >;
    await commands.registerCustomer?.({ customerId: "c-1", email: "c-1@example.com" });
    await app.runUntilIdle();
    await app.restored();
    expect((await app.recipientsOf("c-1")).map(({ status }) => status)).not.toContain("presumed");
  });
});

describe("a forgotten tenant's recipients and its forget ledger", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0).reverse()) await stop();
  });

  const env = {
    BOUNDA_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  };

  interface KeyedArgs {
    readonly storage: Adapter;
    readonly ledger: Adapter | ReturnType<typeof defineForgetLedger> | null;
    readonly tenantKeys: ReturnType<typeof createMemoryTenantKeyStore>;
    readonly told: Notice[];
    readonly failing?: Set<string>;
    readonly logger?: Logger;
  }

  // An app with keys of its own, as one that runs for good, whose ports are doubles.
  const keyed = async ({
    storage,
    ledger,
    tenantKeys,
    told,
    failing = new Set(),
    logger = silentLogger,
  }: KeyedArgs): Promise<BoundaApp> => {
    const app = await createApp({
      registry: registryWithDoubles(
        registryWith({ told, failing }),
        {
          customer: { mailer: sender([]), crm: sender([]) },
          customers: { audience: sender([]) },
        },
        () => undefined,
      ),
      config: {
        storage,
        ports: {},
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: defineTenantKeyStore(() => tenantKeys),
            ...(ledger === null ? {} : { forgetLedger: { store: ledger } }),
          },
        },
      } as never,
      env,
      clock: createFixedClock(START),
      ids: createSequentialIdGenerator({ prefix: `keyed-${stops.length}` }),
      logger,
    });
    stops.push(() => app.stop());
    return app;
  };

  const registerOn = async (app: BoundaApp, customerId: string): Promise<void> => {
    await (
      app.commands as unknown as Record<string, (payload: unknown) => Promise<unknown>>
    ).registerCustomer?.({ customerId, email: `${customerId}@example.com` });
    await app.runUntilIdle();
  };

  interface RestoredArgs {
    readonly ledger: (ledger: Adapter) => KeyedArgs["ledger"];
    readonly logger?: Logger;
    /**
     * Runs once the copy is back, before the app starts again on it.
     */
    readonly onRestored?: () => void;
  }

  // A tenant forgotten after a disclosure made since the copy its database is then restored from
  // was taken, and the app started again on that copy.
  const restoredAfterForgetting = async ({ ledger, logger, onRestored }: RestoredArgs) => {
    const directory = mkdtempSync(join(tmpdir(), "bounda-forgotten-recipients-"));
    const file = join(directory, "store.db");
    const copy = join(directory, "copy.db");
    const tenantKeys = createMemoryTenantKeyStore();
    const ledgerAdapter = memory();
    const told: Notice[] = [];
    const first = createNodeSqliteAdapter(file);
    const before = await keyed({
      storage: first.adapter,
      ledger: ledger(ledgerAdapter),
      tenantKeys,
      told,
    });
    await registerOn(before, "c-0");
    first.db.exec(`VACUUM INTO '${copy}'`);
    await registerOn(before, "c-1");
    told.length = 0;
    await before.forgetTenant("default", { despiteLegalObligations: true });
    // Stopped before its notices went out.
    await before.stop();
    first.db.close();
    copyFileSync(copy, file);
    onRestored?.();
    const after = await keyed({
      storage: createNodeSqliteAdapter(file).adapter,
      ledger: ledger(ledgerAdapter),
      tenantKeys,
      told,
      ...(logger === undefined ? {} : { logger }),
    });
    await after.runUntilIdle();
    return { after, told, ledger: await ledgerAdapter.createForgetLedger({}) };
  };

  const presumedAll = [
    {
      port: "customer.crm",
      type: "TenantForgotten",
      person: "default",
      categories: ["contact", "invoices"],
      presumed: true,
      idempotencyKey: expect.any(String),
      persons: [],
    },
    {
      port: "customer.mailer",
      type: "TenantForgotten",
      person: "default",
      categories: ["contact"],
      presumed: true,
      idempotencyKey: expect.any(String),
      persons: ["c-0"],
    },
    {
      port: "customers.audience",
      type: "TenantForgotten",
      person: "default",
      categories: ["contact"],
      presumed: true,
      idempotencyKey: expect.any(String),
      persons: [],
    },
  ];

  it("tells the recipients a copy restored after the forgetting lost, from the ledger, then clears it", async () => {
    const { after, told, ledger } = await restoredAfterForgetting({ ledger: (store) => store });
    expect(told).toEqual([
      {
        port: "customer.mailer",
        type: "TenantForgotten",
        person: "default",
        categories: ["contact"],
        presumed: false,
        idempotencyKey: expect.any(String),
        persons: ["c-0", "c-1"],
      },
    ]);
    // Every recipient told: no copy restored from now on needs the ledger's disclosures.
    expect(await ledger.read({ limit: 10 })).toEqual([]);
    expect(await ledger.readMark(RESTORE_MARK)).toBe(0);
    // Nor does a forgotten tenant's start or stop raise a mark the clear would have to remove.
    await after.stop();
    expect(await ledger.readMark(RESTORE_MARK)).toBe(0);
  });

  it("presumes every declared recipient holds the tenant's data when the ledger cannot be read", async () => {
    const errors: unknown[] = [];
    let down = false;
    const { told, ledger } = await restoredAfterForgetting({
      ledger: (store) =>
        defineForgetLedger(async ({ tenant }) => {
          const inner = await store.createForgetLedger({ tenant });
          const read: ForgetLedger["read"] = (args) =>
            down ? Promise.reject(new Error("ledger down")) : inner.read(args);
          return { ...inner, read };
        }),
      onRestored: () => {
        down = true;
      },
      logger: {
        ...silentLogger,
        error: (message, fields) => {
          errors.push([message, fields]);
        },
      },
    });
    expect(told).toEqual(presumedAll);
    expect(errors).toContainEqual([
      "the forget ledger could not be read for the disclosures the database lost: every declared recipient is presumed to hold the tenant's data",
      expect.objectContaining({ tenant: "default" }),
    ]);
    expect(await ledger.read({ limit: 10 })).toEqual([]);
  });

  it("presumes every declared recipient holds the tenant's data in a copy without a ledger", async () => {
    const { told } = await restoredAfterForgetting({ ledger: () => null });
    expect(told).toEqual(presumedAll);
  });

  it("presumes every declared recipient on a forgetting settled again after it was cut short", async () => {
    const told: Notice[] = [];
    const inner = memory();
    let failing = false;
    const flaky: Adapter = {
      ...inner,
      createStorage: async () => {
        const storage = await inner.createStorage();
        const transact: Storage["transact"] = (work) => {
          if (!failing) return storage.transact(work);
          failing = false;
          return Promise.reject(new Error("the database went away"));
        };
        return { ...storage, transact };
      },
    };
    const { app, register } = await start({ told, adapter: flaky });
    await register("c-0");
    told.length = 0;
    failing = true;
    await expect(app.forgetTenant("default", { despiteLegalObligations: true })).rejects.toThrow(
      "the database went away",
    );
    // Without a ledger, the database settled again may be a copy that lost disclosures.
    await app.forgetTenant("default", { despiteLegalObligations: true });
    await app.runUntilIdle();
    expect(told).toEqual(presumedAll);
  });

  it("keeps the ledger, pruned past keepFor, until every recipient is told, and clears it then", async () => {
    const told: Notice[] = [];
    const failing = new Set<string>();
    const ledgerAdapter = memory();
    const { app } = await createTestApp({
      registry: registryWith({ told, failing }),
      now: START,
      config: {
        runtime: { personalData: { forgetLedger: { store: ledgerAdapter, keepFor: "1d" } } },
      },
      ports: {
        customer: { mailer: sender([]), crm: sender([]) },
        customers: { audience: sender([]) },
      } as never,
    });
    stops.push(() => app.stop());
    await registerOn(app, "c-1");
    failing.add("customer.mailer");
    await app.forgetTenant("default", { despiteLegalObligations: true });
    const ledger = await ledgerAdapter.createForgetLedger({});
    const old: ForgetLedgerEntry = {
      personId: "c-old",
      categories: null,
      eventId: "old-forgetting",
      forgottenAt: new Date(START.getTime() - 2 * 86_400_000).toISOString(),
      reason: "requested",
    };
    await ledger.append([old]);
    await app.runUntilIdle();
    const [letter] = await app.deadLetters.list({ kind: "recipient" });
    expect(letter).toMatchObject({ handler: "customer.mailer", eventType: "TenantForgotten" });
    // A copy restored now would still need the disclosure to tell the mailer; the old entry is
    // past keepFor.
    expect((await ledger.read({ limit: 10 })).map(({ personId }) => personId)).toEqual(["c-1"]);
    failing.clear();
    await app.deadLetters.retry(letter?.id ?? "");
    await app.runUntilIdle();
    expect(told.map(({ port, type }) => [port, type])).toContainEqual([
      "customer.mailer",
      "TenantForgotten",
    ]);
    expect(await ledger.read({ limit: 10 })).toEqual([]);
  });
});

describe("recipient declarations", () => {
  const failing = async (mailer: unknown, message: string): Promise<void> => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      recipients: Record<string, unknown>;
    };
    customer.recipients.mailer = mailer;
    await expect(createTestApp({ registry })).rejects.toThrow(new ConfigurationError(message));
  };
  const module = (recipient: unknown, drop?: string) => {
    const full = recipientModule("customer.mailer", MAILCHIMP, [], new Set());
    const { [drop ?? "-"]: _, ...rest } = { ...full, recipient } as Record<string, unknown>;
    return rest;
  };

  it("refuses a recipient without a name, a kind, a country or its categories", async () => {
    await failing(
      module({ ...MAILCHIMP, name: " " }),
      "Port customer.mailer: recipient.name must name who receives the data",
    );
    await failing(
      module({ ...MAILCHIMP, kind: "partner" }),
      'Port customer.mailer: recipient.kind "partner" is none of "processor", "joint-controller", "third-party"',
    );
    await failing(
      module({ ...MAILCHIMP, country: "XX" }),
      'Port customer.mailer: recipient.country "XX" is not an ISO 3166-1 alpha-2 code',
    );
    await failing(
      module({ ...MAILCHIMP, categories: [] }),
      "Port customer.mailer: recipient.categories must list the categories of personal data the port sends it",
    );
    await failing(
      module({ ...MAILCHIMP, categories: ["profile"] }),
      'Port customer.mailer: recipient.categories names "profile", which the app does not have',
    );
    await failing(
      module({ ...MAILCHIMP, categories: ["contact", "contact"] }),
      "Port customer.mailer: recipient.categories names a category twice",
    );
    await failing(
      module("Mailchimp"),
      "Port customer.mailer: recipient must be an object: { name, kind, country, categories }",
    );
  });

  it("asks a transfer out of the EEA for its safeguard, and refuses one within it", async () => {
    const { safeguard: _, ...unsafe } = MAILCHIMP;
    await failing(
      module(unsafe),
      'Port customer.mailer: recipient.country US is outside the European Economic Area, so recipient.safeguard names what the transfer rests on: one of "adequacy", "standard-contractual-clauses", "binding-corporate-rules", "code-of-conduct", "certification", "derogation"',
    );
    await failing(
      module({ ...BREVO, safeguard: "adequacy" }),
      "Port customer.mailer: recipient.country FR is in the European Economic Area, so it takes no safeguard",
    );
  });

  it("refuses a recipient without one of its handlers, or with a malformed former key", async () => {
    await failing(
      module(MAILCHIMP, "onProcessingRestrictionLiftAnnounced"),
      "Port customer.mailer: it declares a recipient, so it exports onProcessingRestrictionLiftAnnounced, which tells it of ProcessingRestrictionLiftAnnounced",
    );
    await failing(
      module({ ...MAILCHIMP, formerly: ["mailer"] }),
      'Port customer.mailer: recipient.formerly must list keys such as "customer.mailer", the port\'s before a rename',
    );
    await failing(
      module({ ...MAILCHIMP, formerly: ["customer.crm"] }),
      "Port customer.mailer: recipient.formerly names customer.crm, which is a port of the app",
    );
    await failing(
      module({ ...MAILCHIMP, formerly: ["customer.mailer"] }),
      "Port customer.mailer: recipient.formerly names customer.mailer, which is a port of the app",
    );
  });

  it("refuses a recipient declared on a port without an implementation", async () => {
    const told: Notice[] = [];
    const registry = registryWith({ told });
    const customer = registry.aggregates.customer as unknown as {
      recipients: Record<string, unknown>;
    };
    customer.recipients.ghost = recipientModule("customer.ghost", MAILCHIMP, told, new Set());
    await expect(createTestApp({ registry })).rejects.toThrow(
      "Port customer.ghost: it declares a recipient and has no implementation in infrastructure/ghost/",
    );
  });

  it("warns at start of a recipient that holds data of persons and whose port is gone", async () => {
    const adapter = memory();
    const told: Notice[] = [];
    const first = await start({ told, adapter });
    await first.register("c-1");
    // The audience, still declared, holds c-1's data too and is not warned of.
    await first.queries.shareCustomer?.({ customerId: "c-1" });
    await first.app.stop();
    const warnings: [string, unknown][] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (message, fields) => {
        warnings.push([message, fields]);
      },
    };
    const { app } = await createTestApp({
      registry: registryWith({ told, mailer: null }),
      adapter,
      logger,
    });
    await app.stop();
    expect(
      warnings.filter(
        ([message]) =>
          message ===
          "a recipient holds personal data and its port is not declared: what it is told of goes to dead letters",
      ),
    ).toEqual([
      [
        "a recipient holds personal data and its port is not declared: what it is told of goes to dead letters",
        { recipient: "customer.mailer", persons: 1 },
      ],
    ]);
  });
});
