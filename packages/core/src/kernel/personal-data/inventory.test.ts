import { describe, expect, it } from "vitest";
import type { Config } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { personalDataInventory } from "./inventory.ts";
import { masterKey } from "./master-key.ts";

const handlers = {
  onPersonalDataForgotten: () => {},
  onProcessingRestricted: () => {},
  onProcessingRestrictionLiftAnnounced: () => {},
  onProcessingRestrictionLifted: () => {},
  onPersonalDataRedacted: () => {},
  onTenantForgotten: () => {},
};

const noop = () => [];

const registry = {
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
              plan: z.enum(["free", "pro"]),
            }),
          begin: () => ({}),
        },
        customerNoted: {
          payload: ({ z }: EventPayloadArgs) => z.object({ summary: z.string(), age: z.number() }),
          evolve: ({ state }: { state: unknown }) => state,
        },
        customerTagged: {
          payload: ({ z }: EventPayloadArgs) => z.string(),
          evolve: ({ state }: { state: unknown }) => state,
        },
        planChanged: {
          evolve: ({ state }: { state: unknown }) => state,
        },
      },
      commands: {
        remindCustomer: {
          module: {
            payload: ({ z, personal, person, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: person(z.string()),
                email: personal(z.email()),
                template: notPersonal(z.string()),
              }),
            handler: noop,
          },
        },
      },
      policies: {},
      processes: {
        onboarding: {
          module: {
            config: () => ({ startedBy: [] }),
            state: ({ z, personal, person, deadline }: ProcessStateArgs) =>
              z.object({
                customerId: person(z.string()).nullable().default(null),
                billingAddress: personal(z.string(), { category: "invoices" })
                  .nullable()
                  .default(null),
                reminder: deadline(),
              }),
          },
          handlers: {},
        },
      },
      ports: { mailer: { memory: { default: {} } } },
      recipients: {
        mailer: {
          ...handlers,
          recipient: {
            name: " Mailchimp ",
            kind: "processor",
            country: "US",
            safeguard: "standard-contractual-clauses",
            categories: ["contact"],
          },
        },
      },
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          id: f.string().primaryKey().notPersonal(),
          customerId: f.string().person(),
          email: f.string().personal({ category: "contact" }).index(),
          name: f.string().personal({ clear: true }),
          description: f.string(),
          total: f.number(),
        }),
      },
      projections: {},
      queries: {},
    },
    totals: {
      view: {
        fields: ({ f }: FieldsArgs) => ({ day: f.string().primaryKey().notPersonal() }),
        holdsPersonalData: false,
      },
      projections: {},
      queries: {},
    },
  },
  audit: { onPersonalDataAccess: () => {} },
} as unknown as Registry;

const config: Config = {
  storage: memory(),
  readModels: { totals: memory() },
  runtime: {
    personalData: { retention: "2y" },
    deadLetters: { retention: "30d" },
    overrides: { customer: { snapshot: { every: 50 } } },
  },
};

// Built in each test, which a mutation tool's run of that test sees.
describe("personalDataInventory", () => {
  it("lists every category with its basis, purposes, sources, retention and how many fields it holds", () => {
    const inventory = personalDataInventory({ registry, config });
    const said = { purposes: ["Serve the person"], sources: ["data-subject"] };
    expect(inventory.categories).toEqual([
      { name: "default", basis: null, purposes: [], sources: [], retention: "2y", fields: 2 },
      { name: "contact", basis: "consent", ...said, retention: "730d", fields: 2 },
      { name: "invoices", basis: "legal-obligation", ...said, retention: "6y", fields: 1 },
    ]);
    expect(inventory.automatedDecisions).toEqual([]);
  });

  it("lists the decisions the app makes about a person by automated means alone", () => {
    const scoring = {
      categories: ["contact"],
      logic: "A score of their answers",
      significance: "Whether they are offered the newsletter",
      consequences: "No newsletter",
      profiling: true,
      ground: "explicit-consent",
    } as const;
    const inventory = personalDataInventory({
      registry: {
        ...registry,
        personalData: { ...registry.personalData, automatedDecisions: { scoring } },
      } as Registry,
      config,
    });
    expect(inventory.automatedDecisions).toEqual([{ name: "scoring", ...scoring }]);
  });

  it("lists what holds personal data, whose, where and how it is kept", () => {
    const inventory = personalDataInventory({ registry, config });
    expect(inventory.holders).toEqual([
      {
        kind: "event",
        name: "customer.CustomerRegistered",
        person: null,
        fields: [{ name: "email", category: "contact", sealing: "sealed" }],
        stores: ["event-store", "snapshots"],
        database: "memory",
        location: null,
      },
      {
        kind: "command",
        name: "customer.remindCustomer",
        person: "customerId",
        fields: [{ name: "email", category: "default", sealing: "sealed" }],
        stores: ["scheduled-commands", "dead-letters"],
        database: "memory",
        location: null,
      },
      {
        kind: "process-state",
        name: "customer.onboarding",
        person: "customerId",
        fields: [{ name: "billingAddress", category: "invoices", sealing: "sealed" }],
        stores: ["event-store"],
        database: "memory",
        location: null,
      },
      {
        kind: "read-model",
        name: "customers",
        person: "customerId",
        fields: [
          { name: "email", category: "contact", sealing: "sealed-indexed" },
          { name: "name", category: "default", sealing: "clear" },
        ],
        stores: ["read-model"],
        database: "memory",
        location: null,
      },
    ]);
  });

  it("lists the recipients, and the records the runtime keeps with how long", () => {
    const inventory = personalDataInventory({ registry, config });
    expect(inventory.recipients).toEqual([
      {
        port: "customer.mailer",
        name: "Mailchimp",
        kind: "processor",
        country: "US",
        safeguard: "standard-contractual-clauses",
        categories: ["contact"],
      },
    ]);
    expect(inventory.records).toEqual([
      { name: "personal-keys", where: "memory", location: null, keptFor: null },
      { name: "persons", where: "memory", location: null, keptFor: null },
      { name: "forgettings", where: "memory", location: null, keptFor: null },
      { name: "remembered-answers", where: "memory", location: null, keptFor: "1d" },
      { name: "dead-letters", where: "memory", location: null, keptFor: "30d" },
      { name: "disclosures", where: "memory", location: null, keptFor: null },
      { name: "access-log", where: "app/audit.ts", location: null, keptFor: null },
    ]);
    expect(inventory.security).toEqual({
      masterKey: false,
      tenantKeys: false,
      forgetLedger: false,
    });
  });

  it("tells where a database keeps what it holds when its definition pins it", () => {
    const pinned = { ...memory(), location: "jurisdiction eu" };
    const inventory = personalDataInventory({
      registry,
      config: { ...config, storage: pinned, readModels: { customers: pinned, totals: memory() } },
    });
    expect(
      inventory.holders.map(({ name, database, location }) => [name, database, location]),
    ).toEqual([
      ["customer.CustomerRegistered", "memory", "jurisdiction eu"],
      ["customer.remindCustomer", "memory", "jurisdiction eu"],
      ["customer.onboarding", "memory", "jurisdiction eu"],
      ["customers", "memory", "jurisdiction eu"],
    ]);
    expect(inventory.records.map(({ name, location }) => [name, location])).toEqual([
      ["personal-keys", "jurisdiction eu"],
      ["persons", "jurisdiction eu"],
      ["forgettings", "jurisdiction eu"],
      ["remembered-answers", "jurisdiction eu"],
      ["dead-letters", "jurisdiction eu"],
      ["disclosures", "jurisdiction eu"],
      ["access-log", null],
    ]);
    const apart = personalDataInventory({
      registry,
      config: { ...config, storage: pinned, readModels: { customers: memory() } },
    });
    expect(apart.holders.find(({ name }) => name === "customers")?.location).toBeNull();
  });

  it("refuses a configuration its adapters refuse, as the app does at start", () => {
    const refusing = {
      ...memory(),
      check: () => {
        throw new ConfigurationError("The read model customers is kept in another jurisdiction");
      },
    };
    expect(() =>
      personalDataInventory({
        registry,
        config: { ...config, readModels: { customers: refusing } },
      }),
    ).toThrow("The read model customers is kept in another jurisdiction");
  });

  it("lists the fields declared not personal", () => {
    const inventory = personalDataInventory({ registry, config });
    expect(inventory.notPersonal).toEqual([
      { kind: "command", name: "customer.remindCustomer", field: "template" },
      { kind: "read-model", name: "customers", field: "id" },
      { kind: "read-model", name: "totals", field: "day" },
    ]);
  });

  it("reports what keeps the record from being complete", () => {
    const inventory = personalDataInventory({ registry, config });
    expect(inventory.findings.map(({ kind, holder, field }) => ({ kind, holder, field }))).toEqual([
      { kind: "unclassified", holder: "customer.CustomerNoted", field: "summary" },
      { kind: "looks-personal", holder: "customer.CustomerNoted", field: "age" },
      { kind: "unmarkable", holder: "customer.CustomerTagged", field: null },
      { kind: "unclassified", holder: "customers", field: "description" },
      { kind: "no-basis", holder: null, field: null },
    ]);
    expect(inventory.findings[0]?.message).toBe(
      'customer.CustomerNoted: field "summary" can hold text and is not marked; mark it personal or notPersonal',
    );
    expect(inventory.findings[2]?.message).toBe(
      "customer.CustomerTagged: can hold text no mark reaches; make it an object that keeps only the keys it declares, and mark its fields",
    );
    expect(inventory.findings[1]?.message).toBe(
      'customer.CustomerNoted: field "age" is named like personal data ("age") and is not marked; mark it personal or notPersonal',
    );
  });

  it("finds nothing to report in an app that classifies every field", () => {
    const clean = personalDataInventory({
      registry: {
        aggregates: {
          order: {
            events: {
              orderPlaced: {
                payload: ({ z, notPersonal }: EventPayloadArgs) =>
                  z.object({ sku: notPersonal(z.string()), quantity: z.int() }),
                begin: () => ({}),
              },
            },
            commands: {},
            policies: {},
            processes: {},
          },
        },
        readModels: {},
      } as unknown as Registry,
      config: { storage: memory(), runtime: { telemetry: { errorText: "omit" } } },
    });
    expect(clean.findings).toEqual([]);
    expect(clean.holders).toEqual([]);
    expect(clean.records.map(({ name }) => name)).toEqual([
      "personal-keys",
      "persons",
      "forgettings",
      "remembered-answers",
      "dead-letters",
    ]);
  });

  it("reports logs that carry the text of errors", () => {
    const { findings } = personalDataInventory({
      registry: { aggregates: {}, readModels: {} } as unknown as Registry,
      config: { storage: memory(), runtime: { telemetry: { errorText: "include" } } },
    });
    expect(findings).toEqual([
      {
        kind: "error-text",
        holder: null,
        field: null,
        message:
          'runtime.telemetry.errorText is "include": logs and spans carry the text of errors, which may quote personal data no forgetting reaches',
      },
    ]);
  });

  it("keeps an event of an aggregate without snapshots in the event store alone, and tells the ledger's time", () => {
    const { holders, records, findings, security } = personalDataInventory({
      registry: {
        aggregates: {
          member: {
            events: {
              joined: {
                payload: ({ z, personal }: EventPayloadArgs) =>
                  z.object({ name: personal(z.string()) }),
                begin: () => ({}),
              },
              left: {
                payload: ({ z, person }: EventPayloadArgs) =>
                  z.object({ referrerId: person(z.string()) }),
                evolve: ({ state }: { state: unknown }) => state,
              },
            },
            commands: { leave: { module: { handler: noop } } },
            policies: {},
            processes: {
              offboarding: { module: { config: () => ({ startedBy: [] }) }, handlers: {} },
            },
          },
        },
        readModels: {
          members: {
            view: {
              fields: ({ f }: FieldsArgs) => ({
                memberId: f.string().primaryKey().person(),
                name: f.string().personal(),
              }),
            },
            projections: {},
            queries: {},
          },
          visits: {
            view: {
              fields: ({ f }: FieldsArgs) => ({ memberId: f.string().primaryKey().person() }),
            },
            projections: {},
            queries: {},
          },
          notes: {
            view: {
              fields: ({ f }: FieldsArgs) => ({
                id: f.string().primaryKey().notPersonal(),
                text: f.string().personal(),
              }),
            },
            projections: {},
            queries: {},
          },
        },
      } as unknown as Registry,
      config: {
        storage: memory(),
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: memory(),
            forgetLedger: { store: memory(), keepFor: "400d" },
          },
        },
      },
    });
    expect(holders).toEqual([
      {
        kind: "event",
        name: "member.Joined",
        person: null,
        fields: [{ name: "name", category: "default", sealing: "sealed" }],
        stores: ["event-store"],
        database: "memory",
        location: null,
      },
      {
        kind: "event",
        name: "member.Left",
        person: "referrerId",
        fields: [],
        stores: ["event-store"],
        database: "memory",
        location: null,
      },
      {
        kind: "read-model",
        name: "members",
        person: "memberId",
        fields: [{ name: "name", category: "default", sealing: "sealed" }],
        stores: ["read-model"],
        database: "memory",
        location: null,
      },
      {
        kind: "read-model",
        name: "visits",
        person: "memberId",
        fields: [],
        stores: ["read-model"],
        database: "memory",
        location: null,
      },
      {
        kind: "read-model",
        name: "notes",
        person: null,
        fields: [{ name: "text", category: "default", sealing: "sealed" }],
        stores: ["read-model"],
        database: "memory",
        location: null,
      },
    ]);
    expect(records).toContainEqual({
      name: "forget-ledger",
      where: "forget-ledger",
      location: null,
      keptFor: "400d",
    });
    expect(records).toContainEqual({
      name: "dead-letters",
      where: "memory",
      location: null,
      keptFor: null,
    });
    expect(security).toEqual({ masterKey: true, tenantKeys: true, forgetLedger: true });
    expect(findings.map(({ message }) => message)).toEqual([
      "3 personal fields are in the default category, which declares no legal basis, purpose or source; declare categories in app/personal-data.ts and give each field one",
    ]);
  });

  it("counts one personal field without a basis as one", () => {
    const { findings } = personalDataInventory({
      registry: {
        aggregates: {},
        readModels: {
          members: {
            view: {
              fields: ({ f }: FieldsArgs) => ({
                memberId: f.string().primaryKey().person(),
                name: f.string().personal(),
              }),
            },
            projections: {},
            queries: {},
          },
        },
      } as unknown as Registry,
      config: { storage: memory() },
    });
    expect(findings.map(({ message }) => message)).toEqual([
      "1 personal field is in the default category, which declares no legal basis, purpose or source; declare categories in app/personal-data.ts and give each field one",
    ]);
  });

  it("refuses a payload that names two persons, as the app does", () => {
    expect(() =>
      personalDataInventory({
        registry: {
          aggregates: {
            order: {
              events: {
                orderShared: {
                  payload: ({ z, person }: EventPayloadArgs) =>
                    z.object({ from: person(z.string()), to: person(z.string()) }),
                  begin: () => ({}),
                },
              },
              commands: {},
              policies: {},
              processes: {},
            },
          },
          readModels: {},
        } as unknown as Registry,
        config: { storage: memory() },
      }),
    ).toThrow(
      'order.OrderShared: marks "from" and "to" with person; a payload names at most one person',
    );
  });
});
