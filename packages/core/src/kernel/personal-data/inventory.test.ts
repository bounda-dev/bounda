import { describe, expect, it } from "vitest";
import type { Config } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { memory } from "../../memory/index.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { ProcessStateArgs } from "../../modules/process.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { defineForgetLedger, type ForgetLedgerSource } from "./forget-ledger.ts";
import { personalDataInventory } from "./inventory.ts";
import type { KeyWrapperDefinition } from "./key-wrapper.ts";
import { masterKey } from "./master-key.ts";
import { defineTenantKeyStore, type TenantKeySource } from "./tenant-key-source.ts";
import { DEFAULT_TENANT } from "./tenant-keys.ts";

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
        processedFor: ["direct-marketing"],
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
      ports: {
        mailer: { memory: { default: {} } },
        crm: { memory: { default: {} } },
        archive: { memory: { default: {} } },
        ledger: { memory: { default: {} } },
      },
      returns: {
        crm: {
          returnsPersonalData: {
            find: { persons: () => null, categories: ["invoices", "contact"] },
            ping: false,
          },
        },
        archive: {
          returnsPersonalData: {
            first: { persons: () => null, categories: ["contact"] },
            second: { persons: () => null, categories: ["contact"] },
          },
        },
        ledger: { returnsPersonalData: false },
      },
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
      ports: { lookup: { memory: { default: {} } } },
      returns: {
        lookup: { returnsPersonalData: { persons: () => null, categories: ["contact"] } },
      },
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
  audit: { onPersonalDataAccess: () => {}, onHostRejection: () => {} },
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
  it("lists every category with its basis, purposes, sources, the ports that return its data, retention, exemptions from erasure and how many fields it holds", () => {
    const inventory = personalDataInventory({ registry, config });
    const said = {
      special: null,
      criminal: null,
      purposes: ["Serve the person"],
      sources: ["data-subject"],
    };
    expect(inventory.categories).toEqual([
      {
        name: "default",
        basis: null,
        special: null,
        criminal: null,
        purposes: [],
        processedFor: [],
        erasureExemptions: [],
        sources: [],
        ports: [],
        retention: "2y",
        fields: 2,
      },
      {
        name: "contact",
        basis: "consent",
        ...said,
        processedFor: ["direct-marketing"],
        erasureExemptions: [],
        ports: ["customer.archive", "customer.crm", "customers.lookup"],
        retention: "730d",
        fields: 2,
      },
      {
        name: "invoices",
        basis: "legal-obligation",
        ...said,
        processedFor: [],
        erasureExemptions: [{ exemption: "legal-obligation", article: "17(3)(b)" }],
        ports: ["customer.crm"],
        retention: "6y",
        fields: 1,
      },
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
      { name: "subscriber-failures", where: "memory", location: null, keptFor: "30d" },
      { name: "disclosures", where: "memory", location: null, keptFor: null },
      { name: "access-log", where: "app/audit.ts", location: null, keptFor: null },
      { name: "host-log", where: "app/audit.ts", location: null, keptFor: null },
    ]);
    expect(inventory.security).toEqual({
      masterKey: false,
      tenantKeys: false,
      forgetLedger: false,
    });
  });

  it("tells where a database keeps what it holds as its location declares it", () => {
    const pinned = memory({ location: "eu" });
    const inventory = personalDataInventory({
      registry,
      config: {
        ...config,
        storage: pinned,
        readModels: { customers: pinned, totals: memory({ location: "eu" }) },
      },
    });
    expect(
      inventory.holders.map(({ name, database, location }) => [name, database, location]),
    ).toEqual([
      ["customer.CustomerRegistered", "memory", "eu"],
      ["customer.remindCustomer", "memory", "eu"],
      ["customer.onboarding", "memory", "eu"],
      ["customers", "memory", "eu"],
    ]);
    expect(inventory.records.map(({ name, location }) => [name, location])).toEqual([
      ["personal-keys", "eu"],
      ["persons", "eu"],
      ["forgettings", "eu"],
      ["remembered-answers", "eu"],
      ["dead-letters", "eu"],
      ["subscriber-failures", "eu"],
      ["disclosures", "eu"],
      ["access-log", null],
      ["host-log", null],
    ]);
    expect(inventory.findings.filter(({ kind }) => kind === "no-location")).toEqual([]);
    // Under a storage that declares none, each store says its own.
    const apart = personalDataInventory({
      registry,
      config: { ...config, readModels: { customers: memory({ location: "us" }) } },
    });
    expect(apart.holders.find(({ name }) => name === "customers")?.location).toBe("us");
    expect(apart.holders.find(({ name }) => name === "customer.onboarding")?.location).toBeNull();
  });

  it("refuses a store kept elsewhere than a storage that declares a location, as the app does", () => {
    expect(() =>
      personalDataInventory({
        registry,
        config: {
          ...config,
          storage: memory({ location: "eu" }),
          readModels: { customers: memory() },
        },
      }),
    ).toThrow(
      'readModels.customers declares no location, and storage keeps the app\'s in "eu": every store is kept where the storage is, so give its memory() location: "eu"',
    );
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
      { kind: "no-location", holder: null, field: null },
    ]);
    expect(inventory.findings[5]?.message).toBe(
      "storage declares no location, so the record cannot say where it is kept, nor whether keeping it there is a transfer out of the European Economic Area (article 30(1)(e)); declare one through the options of its memory()",
    );
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

  it("lists the special categories of data and the criminal data of each category, and reports a personal field named like them in a category that does not declare them", () => {
    const said = { retention: "1y", purposes: ["Treat them"], sources: ["data-subject"] };
    const special = { kinds: ["health"], condition: "explicit-consent" } as const;
    const measures = "A nurse reviews it";
    const triage = {
      categories: ["care"],
      logic: "A score of their symptoms",
      significance: "How soon they are seen",
      consequences: "A later appointment",
      profiling: true,
      ground: "explicit-consent",
      measures,
    } as const;
    const inventory = personalDataInventory({
      registry: {
        personalData: {
          automatedDecisions: { triage },
          categories: {
            care: { basis: "contract", ...said, special },
            record: { basis: "legal-obligation", ...said, criminal: { authority: "law" } },
            contact: { basis: "contract", ...said },
          },
        },
        aggregates: {
          patient: {
            events: {
              patientAdmitted: {
                payload: ({ z, personal }: EventPayloadArgs) =>
                  z.object({
                    healthNote: personal(z.string(), { category: "care" }),
                    allergies: personal(z.string(), { category: "contact" }),
                    criminalRecord: personal(z.string(), { category: "record" }),
                    priorConviction: personal(z.string(), { category: "care" }),
                    offenceDate: personal(z.string(), { category: "care" }),
                    religiousConviction: personal(z.string(), { category: "record" }),
                    healthOffence: personal(z.string(), { category: "care" }),
                    sexLife: personal(z.string()),
                    email: personal(z.string(), { category: "contact" }),
                  }),
                begin: () => ({}),
              },
            },
            commands: {},
            policies: {},
            processes: {},
          },
        },
        readModels: {
          patients: {
            view: {
              fields: ({ f }: FieldsArgs) => ({
                id: f.string().primaryKey().person(),
                medicalNotes: f.string().personal({ clear: true }),
              }),
            },
            projections: {},
            queries: {},
          },
        },
      } as unknown as Registry,
      config: { storage: memory(), runtime: { telemetry: { errorText: "omit" } } },
    });
    expect(
      inventory.categories.map(({ name, special: kinds, criminal }) => [name, kinds, criminal]),
    ).toEqual([
      ["default", null, null],
      ["care", special, null],
      ["record", null, { authority: "law" }],
      ["contact", null, null],
    ]);
    expect(inventory.automatedDecisions).toEqual([{ name: "triage", ...triage }]);
    const looksSpecial = inventory.findings.filter(({ kind }) => kind === "looks-special");
    expect(looksSpecial.map(({ holder, field }) => `${holder}: ${field}`)).toEqual([
      "patient.PatientAdmitted: allergies",
      "patient.PatientAdmitted: offenceDate",
      "patient.PatientAdmitted: religiousConviction",
      "patient.PatientAdmitted: healthOffence",
      "patient.PatientAdmitted: sexLife",
      "patients: medicalNotes",
    ]);
    expect(looksSpecial.map(({ message }) => message)).toEqual([
      'patient.PatientAdmitted: field "allergies" is named like special categories of data (article 9) ("allergies") and is in the category "contact", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
      'patient.PatientAdmitted: field "offenceDate" is named like criminal data (article 10) ("offence") and is in the category "care", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
      'patient.PatientAdmitted: field "religiousConviction" is named like special categories of data (article 9) ("religious") and is in the category "record", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
      'patient.PatientAdmitted: field "healthOffence" is named like criminal data (article 10) ("offence") and is in the category "care", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
      'patient.PatientAdmitted: field "sexLife" is named like special categories of data (article 9) ("sexlife") and is in the category "default", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
      'patients: field "medicalNotes" is named like special categories of data (article 9) ("medical") and is in the category "default", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
    ]);
    const either = personalDataInventory({
      registry: {
        personalData: {
          automatedDecisions: {},
          categories: { record: { basis: "public-task", ...said, criminal: { authority: "law" } } },
        },
        aggregates: {
          person: {
            events: {
              noted: {
                payload: ({ z, personal }: EventPayloadArgs) =>
                  z.object({
                    conviction: personal(z.string()),
                    // A category the file does not declare, as only a project that skipped the
                    // type check can have.
                    diagnosis: personal(z.string(), { category: "undeclared" as "record" }),
                    criminalRecord: personal(z.string(), { category: "undeclared" as "record" }),
                  }),
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
    const flagged = either.findings.filter(({ kind }) => kind === "looks-special");
    expect(flagged.map(({ field }) => field)).toEqual([
      "conviction",
      "diagnosis",
      "criminalRecord",
    ]);
    expect(flagged[0]?.message).toBe(
      'person.Noted: field "conviction" is named like special categories of data (article 9) or criminal data (article 10) ("conviction") and is in the category "default", which does not declare them; declare them in a category of app/personal-data.ts and give the field that category',
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
      "subscriber-failures",
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
    // Bounded by default, as data protection by default asks (article 25(2)).
    expect(records).toContainEqual({
      name: "dead-letters",
      where: "memory",
      location: null,
      keptFor: "30d",
    });
    expect(records).toContainEqual({
      name: "master-key",
      where: "key-wrapper",
      location: null,
      keptFor: null,
    });
    expect(records).toContainEqual({
      name: "tenant-keys",
      where: "tenant-keys",
      location: null,
      keptFor: null,
    });
    expect(security).toEqual({ masterKey: true, tenantKeys: true, forgetLedger: true });
    const unplaced = (path: string) =>
      `${path} declares no location, so the record cannot say where it is kept, nor whether keeping it there is a transfer out of the European Economic Area (article 30(1)(e)); declare one through the options of its memory()`;
    expect(findings.map(({ message }) => message)).toEqual([
      "3 personal fields are in the default category, which declares no legal basis, purpose or source; declare categories in app/personal-data.ts and give each field one",
      unplaced("storage"),
      `${unplaced("runtime.personalData.keyWrapper").slice(0, -"the options of its memory()".length)}masterKey({ from, location }) or defineKeyWrapper(create, { location })`,
      unplaced("runtime.personalData.tenantKeys"),
      unplaced("runtime.personalData.forgetLedger.store"),
    ]);
  });

  it("states where the master key is kept, as its key wrapper declares it", () => {
    const recordOf = (keyWrapper: KeyWrapperDefinition) =>
      personalDataInventory({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: memory(), runtime: { personalData: { keyWrapper } } },
      }).records.find(({ name }) => name === "master-key");
    expect(recordOf(masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" }))).toEqual({
      name: "master-key",
      where: "key-wrapper",
      location: "eu",
      keptFor: null,
    });
    expect(recordOf(masterKey({ from: "BOUNDA_MASTER_KEY" }))?.location).toBeNull();
    expect(
      personalDataInventory({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: memory() },
      }).records.find(({ name }) => name === "master-key"),
    ).toBeUndefined();
  });

  it("states where the tenant key store keeps the keys, as it declares it", () => {
    const recordOf = (tenantKeys: TenantKeySource) =>
      personalDataInventory({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: memory(), runtime: { personalData: { tenantKeys } } },
      }).records.find(({ name }) => name === "tenant-keys");
    const keys = () => createMemoryTenantKeyStore();
    expect(recordOf(defineTenantKeyStore(keys, { location: "eu" }))).toEqual({
      name: "tenant-keys",
      where: "tenant-keys",
      location: "eu",
      keptFor: null,
    });
    expect(recordOf(defineTenantKeyStore(keys))?.location).toBeNull();
    expect(recordOf(memory({ location: "us" }))?.location).toBe("us");
  });

  it("reports each store of personal data that declares no location, by what declares it", () => {
    const members = {
      aggregates: {},
      readModels: {
        members: {
          view: {
            fields: ({ f }: FieldsArgs) => ({ memberId: f.string().primaryKey().person() }),
          },
          projections: {},
          queries: {},
        },
        visits: {
          view: { fields: ({ f }: FieldsArgs) => ({ id: f.string().primaryKey().notPersonal() }) },
          projections: {},
          queries: {},
        },
      },
    } as unknown as Registry;
    const unplaced = (config: Config) =>
      personalDataInventory({ registry: members, config })
        .findings.filter(({ kind }) => kind === "no-location")
        .map(({ message }) => message.slice(message.lastIndexOf("; ") + 2));
    expect(
      unplaced({
        storage: memory({ location: "us" }),
        readModels: { members: memory({ location: "us" }), visits: memory({ location: "us" }) },
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", location: "us" }),
            tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore, { location: "us" }),
            forgetLedger: {
              store: defineForgetLedger(
                () => createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT),
                {
                  location: "us",
                },
              ),
            },
          },
        },
      }),
    ).toEqual([]);
    expect(
      personalDataInventory({ registry: members, config: { storage: memory() } }).findings.map(
        ({ message }) => message.slice(0, message.indexOf(" declares")),
      ),
    ).toEqual(["storage"]);
    // A read model that holds no personal data says nothing about persons, wherever it is.
    expect(
      personalDataInventory({
        registry: members,
        config: {
          storage: memory(),
          readModels: { members: memory(), visits: memory() },
          runtime: {
            personalData: {
              keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
              tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore),
              forgetLedger: {
                store: defineForgetLedger(() =>
                  createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT),
                ),
              },
            },
          },
        },
      }).findings.map(({ message }) => message.slice(0, message.indexOf(" declares"))),
    ).toEqual([
      "storage",
      "readModels.members",
      "runtime.personalData.keyWrapper",
      "runtime.personalData.tenantKeys",
      "runtime.personalData.forgetLedger.store",
    ]);
    expect(
      unplaced({
        storage: memory(),
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: defineTenantKeyStore(createMemoryTenantKeyStore),
            forgetLedger: {
              store: defineForgetLedger(() => createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT)),
            },
          },
        },
      }),
    ).toEqual([
      "declare one through the options of its memory()",
      "declare one through masterKey({ from, location }) or defineKeyWrapper(create, { location })",
      "declare one through defineTenantKeyStore(create, { location })",
      "declare one through defineForgetLedger(create, { location })",
    ]);
    // One database under two names is one place to declare.
    const shared = memory();
    expect(
      personalDataInventory({
        registry: members,
        config: { storage: shared, readModels: { members: shared } },
      }).findings.map(({ message }) => message.slice(0, message.indexOf(" declares"))),
    ).toEqual(["storage"]);
    // Only a read model is kept on a database of readModels, whatever else shares its name.
    expect(
      personalDataInventory({
        registry,
        config: { ...config, readModels: { "customer.CustomerRegistered": memory() } },
      })
        .findings.filter(({ kind }) => kind === "no-location")
        .map(({ message }) => message.slice(0, message.indexOf(" declares"))),
    ).toEqual(["storage"]);
    // A disclosure names its person in storage, though no field of the app is personal.
    expect(
      personalDataInventory({
        registry: {
          aggregates: {
            customer: {
              events: {},
              commands: {},
              policies: {},
              processes: {},
              recipients: {
                mailer: {
                  ...handlers,
                  recipient: { name: "Mailer", kind: "processor", country: "DE", categories: [] },
                },
              },
            },
          },
          readModels: {},
        } as unknown as Registry,
        config: { storage: memory() },
      }).findings.map(({ message }) => message.slice(0, message.indexOf(" declares"))),
    ).toEqual(["storage"]);
    // Nothing personal, nothing to place.
    expect(
      personalDataInventory({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: memory() },
      }).findings,
    ).toEqual([]);
  });

  it("states where the forget ledger keeps its entries, as its store declares it", () => {
    const recordOf = (store: ForgetLedgerSource) =>
      personalDataInventory({
        registry: { aggregates: {}, readModels: {} },
        config: { storage: memory(), runtime: { personalData: { forgetLedger: { store } } } },
      }).records.find(({ name }) => name === "forget-ledger");
    const ledger = () => createMemoryForgetLedgers().ledgerOf(DEFAULT_TENANT);
    expect(recordOf(defineForgetLedger(ledger, { location: "eu" }))).toEqual({
      name: "forget-ledger",
      where: "forget-ledger",
      location: "eu",
      keptFor: null,
    });
    expect(recordOf(defineForgetLedger(ledger))?.location).toBeNull();
    expect(recordOf(memory({ location: "us" }))?.location).toBe("us");
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
      config: { storage: memory({ location: "eu" }) },
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
