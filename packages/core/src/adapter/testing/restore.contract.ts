import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config, RuntimeRole } from "../../config/types.ts";
import { type Clock, createFixedClock } from "../../contracts/clock.ts";
import {
  ForgetLedgerUnreconciledError,
  ReadModelRestoringError,
  RestoreUnreconciledError,
  TenantForgottenError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import { EARLIER_ANSWERS_FILED } from "../../kernel/personal-data/earlier-answers.ts";
import {
  defineForgetLedger,
  type ForgetLedgerSource,
} from "../../kernel/personal-data/forget-ledger.ts";
import type { KeyWrapperDefinition } from "../../kernel/personal-data/key-wrapper.ts";
import { pruneTenantForgetLedger } from "../../kernel/personal-data/ledger-prune.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { FORGET_LEDGER_GRACE_MS } from "../../kernel/personal-data/reconciliation.ts";
import { RESEAL_SWITCH_MS } from "../../kernel/personal-data/reseal.ts";
import {
  defineTenantKeyStore,
  type TenantKeySource,
} from "../../kernel/personal-data/tenant-key-source.ts";
import { DEFAULT_TENANT } from "../../kernel/personal-data/tenant-keys.ts";
import { UNWRAPPED_KEY_TTL_MS } from "../../kernel/personal-data/wrapped-keys.ts";
import { GENERATION_INTERVAL_MS, RESTORE_GENERATION } from "../../kernel/shared/restores.ts";
import { createMemoryForgetLedgers } from "../../memory/forget-ledger.ts";
import { createMemoryTenantKeyStore } from "../../memory/tenant-key-store.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import {
  expectForgotten,
  expectTenantForgotten,
  TenantNotForgottenError,
} from "../../testing/expect-forgotten.ts";
import { expectRedacted } from "../../testing/expect-redacted.ts";
import { type Adapter, isAdapter } from "../adapter.ts";
import type { AdapterDefinition } from "../adapter-definition.ts";
import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
  type ForgetLedgerMark,
} from "../storage/forget-ledger.ts";
import type { InspectedStore } from "../storage/inspection.ts";
import type { Table } from "../storage/table.ts";

/**
 * One database an app runs on, and the operator's tools for it.
 */
export interface RestoreTarget {
  /**
   * The app's storage, over the database `backUp` copies.
   */
  readonly storage: Adapter;
  /**
   * Where the forget ledger lives: anything a restore of the storage's database leaves alone.
   */
  readonly forgetLedger: ForgetLedgerSource;
  /**
   * Copies the storage's database, with an app open on it, as a backup tool does.
   */
  backUp(): Promise<void>;
  /**
   * Puts the copy back, and resolves to the storage an app opens on it from then on: `storage`
   * itself for a restore made in place. Called with an app open on `storage` only when the
   * contract's `hot` is `true`, given then the adapter that app opened, through which a file the
   * tenant's keys encrypt is restored; and after it stopped otherwise.
   */
  restore(opened?: Adapter): Promise<Adapter>;
}

export interface RestoreContractArgs {
  /**
   * A fresh, empty database, with a ledger store apart from it.
   */
  readonly create: () => Promise<RestoreTarget>;
  /**
   * Whether the database can be restored under a running app, in place, as the restore tools of
   * PostgreSQL and SQLite do: then the contract also restores under one.
   */
  readonly hot: boolean;
}

export interface RestoreContractFunction {
  (args: RestoreContractArgs): void;
}

interface CustomerState {
  readonly email: string | null;
}

interface CustomerRow {
  readonly customerId: string;
  readonly email: string;
  readonly name: string;
}

type Builders = Readonly<Record<string, (payload?: unknown) => unknown>>;

// Every handler that fails quotes the personal field it read, as a careless one does, so a dead
// letter holds it.
const registry = {
  aggregates: {
    customer: {
      stateFingerprint: "restore-contract",
      state: { initialState: { email: null } satisfies CustomerState },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()), name: personal(z.string()) }),
          evolve: ({ event }: { event: { payload: { email: string | null } } }) => ({
            email: event.payload.email,
          }),
        },
        customerNoted: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ note: personal(z.string()) }),
          evolve: ({ state }: { state: CustomerState }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                email: notPersonal(z.string()),
                name: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; name: string } };
              events: Builders;
            }) => [
              events.customerRegistered?.({
                email: command.payload.email,
                name: command.payload.name,
              }),
            ],
          },
        },
        confirmCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()) }),
            rejections: ({ state }: { state: CustomerState }) => ({
              NotYet: `${state.email ?? "This customer"} cannot be confirmed yet`,
            }),
            handler: ({ reject }: { reject: (name: "NotYet") => never }) => reject("NotYet"),
          },
        },
        noteCustomer: {
          module: {
            payload: ({ z, personal, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()), note: personal(z.string()) }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { note: string } };
              events: Builders;
            }) => [events.customerNoted?.({ note: command.payload.note })],
          },
        },
      },
      policies: {
        welcomeOnCustomerRegistered: {
          module: {
            handler: async ({ event }: { event: { payload: { email: string | null } } }) => {
              throw new ValidationError(`the mailer refuses ${event.payload.email}`, []);
            },
          },
        },
      },
      processes: {
        onboarding: {
          module: {
            config: ({
              events,
            }: {
              events: { customer: { CustomerRegistered: string; CustomerNoted: string } };
            }) => ({
              startedBy: [events.customer.CustomerRegistered],
              completedBy: [events.customer.CustomerNoted],
            }),
            state: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ email: personal(z.string()).optional() }),
          },
          handlers: {
            customer: {
              customerRegistered: {
                handler: ({ event }: { event: { payload: { email: string | null } } }) =>
                  event.payload.email === null ? {} : { email: event.payload.email },
              },
            },
          },
        },
      },
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().notPersonal(),
          name: f.string().notPersonal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: async ({
              event,
              table,
            }: {
              event: StoredEvent<
                "CustomerRegistered",
                { email: string | null; name: string | null }
              >;
              table: Table<CustomerRow>;
            }) => {
              await table.upsert({
                customerId: event.aggregateId,
                email: event.payload.email ?? "",
                name: event.payload.name ?? "",
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
              table: Table<CustomerRow>;
            }) => {
              await table.delete({ customerId: event.payload.personId });
            },
          },
        },
      },
      queries: {
        getCustomer: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<CustomerRow>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: CustomerRow | null }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

interface SealedRow {
  readonly customerId: string;
  readonly email: string | null;
}

interface HandleRow {
  readonly customerId: string;
  readonly handle?: string | null;
}

// A copy of an email that quotes none of it, as a hash or a reformatted value is.
const handleOf = (email: string): string => [...email].reverse().join("");

interface ContactRow {
  readonly customerId: string;
  readonly email: string | null;
}

// The customers with their email kept in the clear, for SQL to sort and filter by.
const clear = {
  ...registry,
  readModels: {
    contacts: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().personal({ clear: true }),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<ContactRow>;
            }) => table.upsert({ customerId: event.aggregateId, email: event.payload.email }),
          },
        },
        bounda: {
          personalDataForgotten: {
            project: ({
              event,
              table,
            }: {
              event: PersonalDataForgottenEvent;
              table: Table<ContactRow>;
            }) => table.delete({ customerId: event.payload.personId }),
          },
        },
      },
      queries: {
        contactOf: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<ContactRow>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: ContactRow | null }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

// The customers with their email sealed at rest, found by its blind index, and no projection of
// the forgetting: nothing but the key forgets them; and a handle derived from the email, which
// only a rebuild takes back once the email is redacted.
const sealed = {
  ...registry,
  readModels: {
    handles: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          handle: f.string().optional().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<HandleRow>;
            }) =>
              table.upsert({
                customerId: event.aggregateId,
                handle: event.payload.email === null ? null : handleOf(event.payload.email),
              }),
          },
        },
      },
      queries: {
        handleOf: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<HandleRow>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: HandleRow | null }) => repositoryData,
        },
      },
    },
    sealedCustomers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal().unique(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: StoredEvent<"CustomerRegistered", { email: string | null }>;
              table: Table<SealedRow>;
            }) => table.upsert({ customerId: event.aggregateId, email: event.payload.email }),
          },
        },
      },
      queries: {
        sealedCustomer: {
          payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
          repository: ({ table, customerId }: { table: Table<SealedRow>; customerId: string }) =>
            table.findOne({ customerId }),
          handler: ({ repositoryData }: { repositoryData: SealedRow | null }) => repositoryData,
        },
        sealedByEmail: {
          payload: ({ z }: PayloadArgs) => z.object({ email: z.string() }),
          repository: ({ table, email }: { table: Table<SealedRow>; email: string }) =>
            table.findOne({ email }),
          handler: ({ repositoryData }: { repositoryData: SealedRow | null }) => repositoryData,
        },
      },
    },
  },
} as unknown as Registry;

// A newsletter address under a consent, a tax id kept by law for six years, and a name in the
// default category.
const categorized = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerBilled: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({
              newsletter: personal(z.string(), { category: "marketing" }),
              taxId: personal(z.string(), { category: "invoices" }),
              name: personal(z.string()),
            }),
          evolve: () => ({}),
        },
      },
      commands: {
        billCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                newsletter: notPersonal(z.string()),
                taxId: notPersonal(z.string()),
                name: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { newsletter: string; taxId: string; name: string } };
              events: Builders;
            }) => [
              events.customerBilled?.({
                newsletter: command.payload.newsletter,
                taxId: command.payload.taxId,
                name: command.payload.name,
              }),
            ],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
  personalData: {
    automatedDecisions: {},
    categories: {
      marketing: {
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
} as unknown as Registry;

const billOf = (person: string) => ({
  newsletter: `${person}.newsletter@example.com`,
  taxId: `${person}-TAX-2026-0001`,
  name: `${person} Billedname`,
});

// Each case starts and stops apps several times and commits hundreds of write transactions, each
// synced to disk: a file database on a Windows runner took up to about 13 s, and once more than
// 30 s, for what takes a few hundred milliseconds elsewhere, waiting on nothing but the disk.
const RESTORE_CASE_TIMEOUT_MS = 60_000;
// How long a case waits for what an instance does behind the clock, on a runner as slow as above
// or a server other tests share, within the case's own timeout.
const BACKGROUND_WAIT_MS = 20_000;

const START = new Date("2026-11-09T09:00:00.000Z");
// Longer than the scenario runs for, so no periodic reconciliation hides a restore the app missed.
const RECONCILE_EVERY_MS = 24 * 60 * 60_000;
// When the scheduled commands written before the copy fall due.
const NOTE_DELAY_MS = 60 * 60_000;

// Two master keys, the second the one a rotation moves to.
const bytes = (seed: number): string =>
  btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => (seed + index * 7) % 256)));
const env = { RESTORE_KEY_1: bytes(1), RESTORE_KEY_2: bytes(2) };
const BEFORE_ROTATION = masterKey({ from: "RESTORE_KEY_1" });
const ROTATED = masterKey({ from: "RESTORE_KEY_2", previous: ["RESTORE_KEY_1"] });
const AFTER_ROTATION = masterKey({ from: "RESTORE_KEY_2" });

/**
 * What a person writes: every value is distinct enough that finding it anywhere means it is
 * theirs.
 */
const valuesOf = (person: string) => ({
  email: `${person}.restore-contract@example.com`,
  name: `${person} Restorecontractname`,
  note: `${person} restore-contract note`,
});

type Commands = Readonly<
  Record<
    string,
    (
      payload: unknown,
      options?: { readonly idempotencyKey?: string; readonly delay?: string },
    ) => Promise<unknown>
  >
>;
interface StartOptions {
  readonly role?: RuntimeRole;
  readonly strict?: boolean;
  readonly registry?: Registry;
}

type Queries = Readonly<Record<string, (payload: unknown) => Promise<unknown>>>;

interface Started {
  readonly app: BoundaApp;
  readonly commands: Commands;
  readonly queries: Queries;
}

/**
 * A ledger whose reads fail while `failing` is set.
 */
const faultyLedger = (source: ForgetLedgerSource) => {
  // `marksFailing` fails the raised marks alone, `entriesFailing` the reads of entries alone.
  const state = { failing: false, marksFailing: false, entriesFailing: false };
  // Each ledger the apps opened, as it is, for what a test writes to it directly.
  const opened: ForgetLedger[] = [];
  const down = (): void => {
    if (state.failing) throw new Error("the ledger is down");
  };
  const definition = defineForgetLedger(async (args) => {
    const inner: ForgetLedger =
      source.kind === "bounda-forget-ledger"
        ? await source.create(args)
        : await source.createForgetLedger({ tenant: args.tenant, keepForMs: args.keepForMs });
    opened.push(inner);
    return {
      ...inner,
      append: async (entries) => {
        down();
        return inner.append(entries);
      },
      read: async (readArgs) => {
        down();
        if (state.entriesFailing) throw new Error("the ledger's entries are down");
        return inner.read(readArgs);
      },
      readMark: async (name) => {
        down();
        return inner.readMark(name);
      },
      raiseMark: async (name, mark) => {
        down();
        if (state.marksFailing) throw new Error("the ledger's marks are down");
        return inner.raiseMark(name, mark);
      },
    };
  });
  return { definition, state, opened };
};

// How long a read of `laggingLedger` may lag a write, as Workers KV's.
const LAG_MS = 60_000;

/**
 * A ledger whose writes a read shows only `LAG_MS` after they landed, as Workers KV's: every value
 * of a mark kept with each time it was raised, and an entry shown as its intention until its
 * committed copy shows, the entries kept by the store's own ledger.
 */
const laggingLedger = (source: ForgetLedgerSource, clock: Clock) => {
  const marks = new Map<string, { readonly mark: ForgetLedgerMark; readonly landed: number }[]>();
  // When each entry's intention, and its committed copy, first landed; one not here, written
  // outside the app, shows at once.
  const landed = new Map<string, number>();
  const landingOf = (eventId: string, committed: boolean): string =>
    `${eventId}\u0000${committed ? "committed" : "intended"}`;
  const shows = (key: string): boolean =>
    (landed.get(key) ?? Number.NEGATIVE_INFINITY) <= clock.now().getTime() - LAG_MS;
  const byValue = (a: ForgetLedgerMark, b: ForgetLedgerMark): number =>
    b.value - a.value || Date.parse(a.raisedAt) - Date.parse(b.raisedAt);
  return defineForgetLedger(async (args) => {
    const inner: ForgetLedger =
      source.kind === "bounda-forget-ledger"
        ? await source.create(args)
        : await source.createForgetLedger({ tenant: args.tenant, keepForMs: args.keepForMs });
    const raised = (name: string) => {
      const key = `${args.tenant}\u0000${name}`;
      const kept = marks.get(key) ?? [];
      marks.set(key, kept);
      return kept;
    };
    // What a read shows of an entry the store holds: its committed copy, else its intention, or
    // nothing yet.
    const shownAs = (entry: ForgetLedgerEntry): ForgetLedgerEntry | null => {
      if (entry.committed !== false && shows(landingOf(entry.eventId, true))) return entry;
      const intended = landingOf(entry.eventId, false);
      if (!landed.has(intended) && entry.committed !== false) return null;
      return shows(intended) ? { ...entry, committed: false } : null;
    };
    return {
      ...inner,
      visibilityDelayMs: LAG_MS,
      append: async (entries) => {
        await inner.append(entries);
        for (const { eventId, committed } of entries) {
          const key = landingOf(eventId, committed !== false);
          if (!landed.has(key)) landed.set(key, clock.now().getTime());
        }
      },
      read: async ({ after, limit }) =>
        (await inner.read({ limit: Number.MAX_SAFE_INTEGER }))
          .flatMap((entry) => {
            const shown = shownAs(entry);
            return shown === null ? [] : [shown];
          })
          .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
          .slice(0, limit),
      readMark: async (name) =>
        raised(name)
          .filter(({ landed }) => landed <= clock.now().getTime() - LAG_MS)
          .map(({ mark }) => mark)
          .sort(byValue),
      raiseMark: async (name, mark) => {
        const kept = raised(name);
        const same = ({ mark: held }: { readonly mark: ForgetLedgerMark }) =>
          held.value === mark.value && held.raisedAt === mark.raisedAt;
        if (!kept.some(same)) kept.push({ mark, landed: clock.now().getTime() });
      },
      pruneMarks: async (name, before) => {
        const kept = raised(name);
        const [highest] = kept
          .map(({ mark }) => mark)
          .filter(({ raisedAt }) => raisedAt < before)
          .sort(byValue);
        const left = kept.filter(({ mark }) => mark === highest || mark.raisedAt >= before);
        kept.splice(0, kept.length, ...left);
      },
    };
  });
};

/**
 * What every adapter must guarantee when its database is restored from a backup, with the app
 * running or at its next start: nobody forgotten after the copy was taken can be read again
 * anywhere (events, read models, snapshots, idempotency records, scheduled commands, dead letters,
 * process state, export, the database's own rows), and the app goes on working. Call it inside a
 * `describe` of the adapter's test file.
 */
// The adapter the app opened: a file its adapter encrypts under the tenant's keys opens only
// through them, as the app holds them.
const openedAs = (definition: AdapterDefinition | undefined): Adapter => {
  if (definition === undefined || !isAdapter(definition)) {
    throw new Error("The app holds no adapter there");
  }
  return definition;
};

export const restoreContract: RestoreContractFunction = ({ create, hot }) => {
  describe("restore contract", () => {
    const stops: (() => Promise<void>)[] = [];
    // Where the tenant's key lives, apart from the database: a restore of it leaves the store as
    // it is, as one of another database, a KV namespace or a KMS does.
    let tenantKeys: TenantKeySource = defineTenantKeyStore(() => createMemoryTenantKeyStore());

    beforeEach(() => {
      const store = createMemoryTenantKeyStore();
      tenantKeys = defineTenantKeyStore(() => store);
    });

    afterEach(async () => {
      for (const stop of stops.splice(0).reverse()) await stop();
    });

    const start = async (
      storage: Adapter,
      forgetLedger: ForgetLedgerSource | null,
      keyWrapper: KeyWrapperDefinition,
      clock: Clock,
      { role = "all", strict = false, registry: chosen = registry }: StartOptions = {},
    ): Promise<Started> => {
      const app = await createApp({
        registry: chosen,
        config: {
          storage,
          runtime: {
            role,
            personalData: {
              keyWrapper,
              tenantKeys,
              ...(forgetLedger === null
                ? {}
                : {
                    forgetLedger: {
                      store: forgetLedger,
                      reconcileEvery: RECONCILE_EVERY_MS,
                      strict,
                    },
                  }),
            },
            policies: { retry: { strategy: "none" } },
            overrides: { customer: { snapshot: { every: 1 } } },
          },
        },
        clock,
        env,
      });
      stops.push(() => app.stop());
      return {
        app,
        commands: app.commands as unknown as Commands,
        queries: app.queries as unknown as Queries,
      };
    };

    // Everything a person leaves behind: events, a read model row, a snapshot, an idempotency
    // record of a rejection that quotes them, a scheduled command, a dead letter and a process.
    const write = async ({ app, commands }: Started, person: string): Promise<void> => {
      const { email, name, note } = valuesOf(person);
      await commands.registerCustomer?.(
        { customerId: person, email, name },
        { idempotencyKey: `register-${person}` },
      );
      await commands
        .confirmCustomer?.({ customerId: person }, { idempotencyKey: `confirm-${person}` })
        .catch(() => undefined);
      await commands.noteCustomer?.({ customerId: person, note }, { delay: "1h" });
      await app.runUntilIdle();
    };

    // The ids of the person's `PersonalDataForgotten`, in order.
    const forgettings = async (app: BoundaApp, person: string): Promise<readonly string[]> =>
      (await app.events.read({ limit: 1_000 }))
        .filter((event) => event.type === "PersonalDataForgotten" && event.aggregateId === person)
        .map((event) => event.id);

    // Every table of the storage, and what the app reads back of the person.
    const expectForgottenIn = async ({ app, queries }: Started, person: string): Promise<void> => {
      await expectForgotten(openedAs(app.config.storage), person, {
        values: Object.values(valuesOf(person)),
        places: {
          query: await queries.getCustomer?.({ customerId: person }),
          export: await app.exportPersonalData(person),
          "dead letters": await app.deadLetters.list(),
        },
      });
    };

    // Every event of the person whose fields hold the value, as their export lists them.
    const holding = async (app: BoundaApp, person: string, value: unknown) =>
      (await app.exportPersonalData(person)).events.flatMap((event) => {
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

    // The ids of the person's `PersonalDataRedacted`, in order.
    const redactions = async (app: BoundaApp, person: string): Promise<readonly string[]> =>
      (await app.events.read({ limit: 1_000 }))
        .filter((event) => event.type === "PersonalDataRedacted" && event.aggregateId === person)
        .map((event) => event.id);

    // Nothing the app hands out or stores reads the old value, and the sealed read model finds
    // nothing by it.
    const expectRedactedIn = async (
      { app, queries }: Started,
      person: string,
      value: string,
    ): Promise<void> => {
      const exported = await app.exportPersonalData(person);
      expect(JSON.stringify(exported)).not.toContain(value);
      expect(await queries.sealedCustomer?.({ customerId: person })).toEqual({
        customerId: person,
        email: null,
      });
      expect(await queries.sealedByEmail?.({ email: value })).toBeNull();
      const handle = (await queries.handleOf?.({ customerId: person })) as HandleRow | null;
      expect(handle?.handle ?? null).toBeNull();
      await expectRedacted(openedAs(app.config.storage), person, {
        values: [value, handleOf(value)],
        places: { export: exported, "dead letters": await app.deadLetters.list() },
      });
    };

    const expectReadable = async ({ app, queries }: Started, person: string): Promise<void> => {
      const { email, name } = valuesOf(person);
      expect(await queries.getCustomer?.({ customerId: person })).toEqual({
        customerId: person,
        email,
        name,
      });
      const exported = await app.exportPersonalData(person);
      expect(exported.events[0]?.data).toEqual({ email, name });
    };

    const scenario = async (restoring: "hot" | "at start"): Promise<void> => {
      const target = await create();
      const clock = createFixedClock(START);
      // Before the copy: ana, bob and dan register, cy registers and is forgotten.
      const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
      for (const person of ["ana", "bob", "cy", "dan"]) await write(first, person);
      const cyForgotten = (await first.app.forget("cy")).eventIds;
      await first.app.runUntilIdle();
      await target.backUp();

      // After the copy: ana is forgotten, the master key rotates, then bob and eve, who registered
      // after the copy, are forgotten, and more is written.
      const anaForgotten = (await first.app.forget("ana")).eventIds;
      await first.app.runUntilIdle();
      await first.app.stop();
      clock.advance(60_000);
      const rotated = await start(target.storage, target.forgetLedger, ROTATED, clock);
      await rotated.app.runUntilIdle();
      await write(rotated, "eve");
      const bobForgotten = (await rotated.app.forget("bob")).eventIds;
      await rotated.app.forget("eve");
      await rotated.app.runUntilIdle();
      for (const person of ["ana", "bob", "cy", "eve"]) {
        await expectForgottenIn(rotated, person);
      }

      let storage: Adapter;
      let restored: Started;
      if (restoring === "hot") {
        storage = await target.restore(openedAs(rotated.app.config.storage));
      } else {
        await rotated.app.stop();
        storage = await target.restore();
      }
      // The scheduled commands in the copy fall due: ana's and bob's must not run.
      clock.advance(NOTE_DELAY_MS);
      if (restoring === "hot") {
        restored = rotated;
        await restored.app.runUntilIdle();
      } else {
        restored = await start(storage, target.forgetLedger, ROTATED, clock);
      }

      // Everyone forgotten after the copy was taken, and still holding a key in it, is forgotten
      // again; cy, forgotten before it, and eve, who is not in it, are not.
      // The forgettings the copy lost are committed again, as the ledger recorded them before they
      // committed: under their own ids.
      expect(await forgettings(restored.app, "ana")).toEqual(anaForgotten);
      expect(await forgettings(restored.app, "bob")).toEqual(bobForgotten);
      for (const person of ["ana", "bob"]) {
        await expectForgottenIn(restored, person);
        // What the copy remembered of their commands is erased with them: a retry runs nothing.
        const { email, name } = valuesOf(person);
        await expect(
          restored.commands.registerCustomer?.(
            { customerId: person, email, name },
            { idempotencyKey: `register-${person}` },
          ),
        ).rejects.toMatchObject({ code: "IDEMPOTENT_ANSWER_ERASED" });
      }
      expect(await forgettings(restored.app, "cy")).toEqual(cyForgotten);
      expect(await forgettings(restored.app, "eve")).toEqual([]);
      await expectForgottenIn(restored, "cy");
      await expectForgottenIn(restored, "eve");
      expect(await restored.app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
      // Found by the newest event this instance saw under a running app, by the ledger's mark at
      // start.
      expect((await restored.app.status()).restoresFound).toBe(1);

      // dan, whom nobody forgot, reads as before, his key rewrapped again under the new master key.
      await restored.app.runUntilIdle();
      await expectReadable(restored, "dan");
      const noted = (await restored.app.events.read({ limit: 1_000 }))
        .filter((event) => event.type === "CustomerNoted")
        .map((event) => event.aggregateId);
      expect(noted).toContain("dan");
      expect(noted).not.toContain("ana");
      expect(noted).not.toContain("bob");

      // The app goes on: a new person registers and is projected, dan is forgotten.
      await write(restored, "fay");
      await expectReadable(restored, "fay");
      await restored.app.forget("dan");
      await restored.app.runUntilIdle();
      await expectForgottenIn(restored, "dan");
      await restored.app.stop();

      // A normal start forgets nobody again, and opens fay's key without the old master key.
      clock.advance(60_000);
      const next = await start(storage, target.forgetLedger, AFTER_ROTATION, clock);
      await expectReadable(next, "fay");
      for (const person of ["ana", "bob", "dan"]) {
        expect((await forgettings(next.app, person)).length).toBe(1);
      }
    };

    it(
      "forgets again at the start after a restore whoever was forgotten since the copy, everywhere, and goes on",
      async () => {
        await scenario("at start");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "forgets again, at the worker's next pass, whoever a restore under the running app brings back",
      async () => {
        await scenario("hot");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // The ledger the source opens for the tenant, as an app does, for what a test reads of it.
    const ledgerOf = async (source: ForgetLedgerSource): Promise<ForgetLedger> =>
      source.kind === "bounda-forget-ledger"
        ? source.create({ env, tenant: DEFAULT_TENANT })
        : source.createForgetLedger({ tenant: DEFAULT_TENANT });

    // A forgetting the copy lacks stays in the ledger, pruned with no app running, until an app
    // applies it again; then it goes. `hot` prunes beside the app the copy was restored under.
    const pruneScenario = async (
      restoring: "hot" | "at start",
      skip: (reason: string) => void,
    ): Promise<void> => {
      const target = await create();
      const ledger = await ledgerOf(target.forgetLedger);
      stops.push(async () => ledger.close?.());
      if (ledger.prune === undefined) return skip("the ledger expires its entries on its own");
      const clock = createFixedClock(START);
      const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
      for (const person of ["ana", "bob"]) await write(first, person);
      await target.backUp();
      const anaForgotten = (await first.app.forget("ana")).eventIds;
      await first.app.runUntilIdle();
      const [{ forgottenAt } = { forgottenAt: "" }] = await ledger.read({ limit: 1 });

      let storage: Adapter;
      if (restoring === "hot") {
        storage = await target.restore(openedAs(first.app.config.storage));
      } else {
        await first.app.stop();
        storage = await target.restore();
      }
      const config: Config = {
        storage,
        runtime: {
          personalData: {
            keyWrapper: BEFORE_ROTATION,
            tenantKeys,
            forgetLedger: { store: target.forgetLedger, keepFor: "1d" },
          },
        },
      };
      const later = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
      expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toEqual({
        tenant: DEFAULT_TENANT,
        before: forgottenAt,
        unapplied: true,
        named: true,
        stranded: false,
      });
      expect((await ledger.read({ limit: 10 })).map(({ personId }) => personId)).toContain("ana");

      clock.advance(60_000);
      const restored =
        restoring === "hot"
          ? first
          : await start(storage, target.forgetLedger, BEFORE_ROTATION, clock);
      await restored.app.runUntilIdle();
      expect(await forgettings(restored.app, "ana")).toEqual(anaForgotten);
      await expectForgottenIn(restored, "ana");
      await expectReadable(restored, "bob");

      // Beside the running app, now that its database holds every entry.
      expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toEqual({
        tenant: DEFAULT_TENANT,
        before: new Date(later.getTime() - 24 * 60 * 60_000).toISOString(),
        unapplied: false,
        named: true,
        stranded: false,
      });
      expect(await ledger.read({ limit: 10 })).toEqual([]);
    };

    it(
      "keeps, pruning with no app running, what a copy restored while the app was stopped lacks, until its start applies it",
      async (context) => {
        await pruneScenario("at start", (reason) => context.skip(reason));
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "keeps, pruning beside the app, what a copy restored under it lacks, until its next pass applies it",
      async (context) => {
        await pruneScenario("hot", (reason) => context.skip(reason));
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "prunes, with no app running, the intentions nothing can apply, and keeps those a key or a restore still needs",
      async (context) => {
        const target = await create();
        const ledger = await ledgerOf(target.forgetLedger);
        stops.push(async () => ledger.close?.());
        if (ledger.prune === undefined)
          return context.skip("the ledger expires its entries on its own");
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        for (const person of ["ana", "bob", "cy"]) await write(first, person);
        await first.app.forget("bob");
        await first.app.restrict("cy", { ground: "objection-pending" });
        await first.app.runUntilIdle();
        const bobKeys = (await ledger.read({ limit: 100 })).find(
          ({ personId }) => personId === "bob",
        )?.fingerprints;
        expect(bobKeys?.length).toBeGreaterThan(0);
        const minutes = (minute: number): string =>
          new Date(START.getTime() + minute * 60_000).toISOString();
        const intention = (personId: string, minute: number): ForgetLedgerEntry => ({
          personId,
          categories: null,
          eventId: `019a6b1e-0000-7000-8000-0000000000${String(60 + minute).padStart(2, "0")}`,
          forgottenAt: minutes(minute),
          reason: "requested",
          committed: false,
        });
        await ledger.append([
          // A forgetting whose commit never happened, of keys bob no longer holds.
          {
            ...intention("bob", -6),
            fingerprints: bobKeys ?? [],
            reached: { generation: 0, position: 0 },
          },
          // A restriction of cy's that never committed, which a later change superseded.
          {
            ...intention("cy", -5),
            restriction: {
              type: "ProcessingRestricted",
              payload: {
                personId: "cy",
                ground: "accuracy-contested",
                categories: null,
                restrictions: [
                  { ground: "accuracy-contested", categories: null, since: minutes(-5) },
                ],
              },
            },
          },
          // A forgetting of any key of ana's, who holds them still.
          intention("ana", -4),
        ]);
        const config: Config = {
          storage: target.storage,
          runtime: {
            personalData: {
              keyWrapper: BEFORE_ROTATION,
              tenantKeys,
              forgetLedger: { store: target.forgetLedger, keepFor: "1d" },
            },
          },
        };
        const later = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
        expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toEqual({
          tenant: DEFAULT_TENANT,
          before: minutes(-4),
          unapplied: true,
          named: true,
          stranded: false,
        });
        expect((await ledger.read({ limit: 1 }))[0]?.personId).toBe("ana");

        // Once ana holds no key, an intention written where the database has not reached stays.
        await first.app.forget("ana");
        await first.app.runUntilIdle();
        await ledger.append([
          {
            ...intention("bob", -3),
            reached: { generation: Number.MAX_SAFE_INTEGER, position: 0 },
          },
        ]);
        expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toEqual({
          tenant: DEFAULT_TENANT,
          before: minutes(-3),
          unapplied: true,
          named: true,
          stranded: false,
        });
        expect((await ledger.read({ limit: 1 }))[0]?.forgottenAt).toBe(minutes(-3));
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "prunes, with no app running, a redaction's and a retention's intention as the app's reconciliation decides them",
      async (context) => {
        const target = await create();
        const ledger = await ledgerOf(target.forgetLedger);
        stops.push(async () => ledger.close?.());
        if (ledger.prune === undefined)
          return context.skip("the ledger expires its entries on its own");
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        for (const person of ["ana", "bob"]) await write(first, person);
        const registered = (await first.app.events.read({ limit: 1_000 })).find(
          (event) => event.type === "CustomerRegistered" && event.aggregateId === "ana",
        );
        if (registered === undefined) throw new Error("ana registered");
        const redacted = {
          id: registered.id,
          aggregateType: "customer",
          aggregateId: "ana",
          type: "CustomerRegistered",
          fields: ["email"],
        };
        const minutes = (minute: number): string =>
          new Date(START.getTime() + minute * 60_000).toISOString();
        await ledger.append([
          // bob's forgetting for inactivity whose commit never happened, which this app's
          // retention, which forgets nobody, would never commit again.
          {
            personId: "bob",
            categories: null,
            eventId: "019a6b1e-0000-7000-8000-000000000054",
            forgottenAt: minutes(-6),
            reason: "retention",
            committed: false,
          },
          // ana's redaction whose commit never happened, which would still seal her email.
          {
            personId: "ana",
            categories: null,
            eventId: "019a6b1e-0000-7000-8000-000000000055",
            forgottenAt: minutes(-5),
            reason: "requested",
            committed: false,
            redaction: { events: [redacted] },
          },
        ]);
        const config: Config = {
          storage: target.storage,
          runtime: {
            personalData: {
              keyWrapper: BEFORE_ROTATION,
              tenantKeys,
              forgetLedger: { store: target.forgetLedger, keepFor: "1d" },
            },
          },
        };
        const later = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
        expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toEqual({
          tenant: DEFAULT_TENANT,
          before: minutes(-5),
          unapplied: true,
          named: true,
          stranded: false,
        });
        expect((await ledger.read({ limit: 1 }))[0]?.personId).toBe("ana");

        // Once redacted, ana's email reads as redacted: nothing is left for the intention to seal.
        await first.app.redact("ana", { events: [redacted] } as never);
        await first.app.runUntilIdle();
        expect(await pruneTenantForgetLedger({ registry, config, env, now: later })).toMatchObject({
          before: new Date(later.getTime() - 24 * 60 * 60_000).toISOString(),
          unapplied: false,
        });
        expect(await ledger.read({ limit: 10 })).toEqual([]);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "prunes a store the configuration no longer names apart from its cursor, and tells what it keeps there that no app reads",
      async (context) => {
        const target = await create();
        const ledger = await ledgerOf(target.forgetLedger);
        stops.push(async () => ledger.close?.());
        if (ledger.prune === undefined)
          return context.skip("the ledger expires its entries on its own");
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        for (const person of ["ana", "bob"]) await write(first, person);
        await first.app.forget("ana");
        await first.app.runUntilIdle();
        await target.backUp();
        clock.advance(60_000);
        await first.app.forget("bob");
        await first.app.runUntilIdle();
        await first.app.stop();
        const storage = await target.restore();
        const bob = (await ledger.read({ limit: 10 })).find(({ personId }) => personId === "bob");
        if (bob === undefined) throw new Error("bob's forgetting is in the ledger");

        // The ledger moved to another store, which holds none of the entries the copy lacks.
        const ledgers = createMemoryForgetLedgers();
        const moved = defineForgetLedger(({ tenant }) => ledgers.ledgerOf(tenant));
        const config: Config = {
          storage,
          runtime: {
            personalData: {
              keyWrapper: BEFORE_ROTATION,
              tenantKeys,
              forgetLedger: { store: moved, keepFor: "1d" },
            },
          },
        };
        const later = new Date(START.getTime() + 2 * 24 * 60 * 60_000);
        const pruned = () =>
          pruneTenantForgetLedger({
            registry,
            config,
            env,
            store: target.forgetLedger,
            now: later,
          });
        expect(await pruned()).toEqual({
          tenant: DEFAULT_TENANT,
          before: bob.forgottenAt,
          unapplied: true,
          named: false,
          stranded: true,
        });
        expect(new Set((await ledger.read({ limit: 10 })).map(({ personId }) => personId))).toEqual(
          new Set(["bob"]),
        );

        // Copied into the ledger it names, the next start applies it, and then it goes there too.
        await ledgers.ledgerOf(DEFAULT_TENANT).append([bob]);
        expect(await pruned()).toMatchObject({ unapplied: true, stranded: false });
        clock.advance(60_000);
        const restored = await start(storage, moved, BEFORE_ROTATION, clock);
        await restored.app.runUntilIdle();
        await expectForgottenIn(restored, "bob");
        await restored.app.stop();
        expect(await pruned()).toEqual({
          tenant: DEFAULT_TENANT,
          before: new Date(later.getTime() - 24 * 60 * 60_000).toISOString(),
          unapplied: false,
          named: false,
          stranded: false,
        });
        expect(await ledger.read({ limit: 10 })).toEqual([]);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // Every fingerprint of a key `store` keeps.
    const fingerprintsOf = async (storage: Adapter, store: InspectedStore) =>
      new Set(
        (await storage.inspect())
          .filter((table) => table.store === store)
          .flatMap(({ rows }) => rows.map(({ fingerprint }) => String(fingerprint))),
      );

    it(
      "reseals every person's data under new keys, and a copy from before forgets again whoever was forgotten since",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        for (const person of ["ana", "bob", "dan"]) await write(first, person);
        await target.backUp();
        const storage = openedAs(first.app.config.storage);
        const old = await fingerprintsOf(storage, "personalKeys");
        await first.app.rotateTenantKey({ reseal: true });
        await first.app.runUntilIdle();
        clock.advance(RESEAL_SWITCH_MS);
        await first.app.runUntilIdle();
        expect(await first.app.status()).toMatchObject({
          keyRotation: { reseal: { superseded: 0 } },
        });
        // No old key is named anywhere but in the record of what superseded what.
        for (const { name, store, rows } of await storage.inspect()) {
          if (store === "supersededKeys") {
            expect(rows.every((row) => row.key === null)).toBe(true);
            continue;
          }
          const text = JSON.stringify(rows);
          expect(
            [...old].filter((fingerprint) => text.includes(fingerprint)),
            name,
          ).toEqual([]);
        }
        await expectReadable(first, "dan");
        await expectReadable(first, "ana");
        const bobForgotten = (await first.app.forget("bob")).eventIds;
        await first.app.runUntilIdle();
        await expectForgottenIn(first, "bob");
        await first.app.stop();

        // The copy holds the keys the reseal replaced: the ledger names them with bob's.
        const restored = await start(
          await target.restore(),
          target.forgetLedger,
          BEFORE_ROTATION,
          clock,
        );
        await restored.app.runUntilIdle();
        expect(await forgettings(restored.app, "bob")).toEqual(bobForgotten);
        await expectForgottenIn(restored, "bob");
        await expectReadable(restored, "dan");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "files answers under the database's key a copy from before a reseal holds, once a restore of it is found",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        await first.app.rotateTenantKey({ reseal: true });
        await first.app.runUntilIdle();
        // A generation written after the copy, which tells the copy apart once it is back.
        clock.advance(GENERATION_INTERVAL_MS);
        await first.app.runUntilIdle();
        await target.restore(openedAs(first.app.config.storage));
        clock.advance(GENERATION_INTERVAL_MS);
        await first.app.runUntilIdle();
        const { email, name } = valuesOf("dan");
        const register = () =>
          first.commands.registerCustomer?.(
            { customerId: "dan", email, name },
            { idempotencyKey: "register-dan" },
          );
        const answer = await register();
        await first.app.runUntilIdle();
        // Past the time this instance takes what the store says as true: it holds no other key.
        clock.advance(UNWRAPPED_KEY_TTL_MS);
        expect(await register()).toEqual(answer);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // A copy taken by a version that filed answers by the caller's key itself, in the clear: the
    // app files it under the key's HMAC, erased, before a retry of it can run the command again.
    const earlierAnswerScenario = async (restoring: "hot" | "at start"): Promise<void> => {
      const target = await create();
      const clock = createFixedClock(START);
      const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
      await write(first, "ana");
      const stores = await openedAs(first.app.config.storage).createStorage();
      await stores.idempotencyStore.put({
        key: "earlier-1",
        answer: {
          fingerprint: "fp",
          outcome: { aggregateType: "customer", aggregateId: "zed", version: 1 },
        },
        expiresAt: new Date(START.getTime() + 86_400_000).toISOString(),
        persons: [],
        now: clock.now(),
      });
      await stores.checkpointStore.remove(EARLIER_ANSWERS_FILED);
      await stores.close();
      await target.backUp();
      // What the app writes after the copy is how a restore under it is found.
      await write(first, "bob");
      if (restoring === "at start") await first.app.stop();
      const storage = await target.restore(
        restoring === "hot" ? openedAs(first.app.config.storage) : undefined,
      );
      clock.advance(60_000);
      const restored =
        restoring === "hot"
          ? first
          : await start(storage, target.forgetLedger, BEFORE_ROTATION, clock);
      await restored.app.runUntilIdle();
      const { email, name } = valuesOf("zed");
      await expect(
        restored.commands.registerCustomer?.(
          { customerId: "zed", email, name },
          { idempotencyKey: "earlier-1" },
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENT_ANSWER_ERASED" });
      expect(
        (await restored.app.events.read({ limit: 1_000 })).filter(
          (event) => event.aggregateId === "zed",
        ),
      ).toEqual([]);
      const after = await openedAs(restored.app.config.storage).createStorage();
      const kept = await after.idempotencyStore.list({ now: clock.now() });
      await after.close();
      expect(JSON.stringify(kept)).not.toContain("earlier-1");
    };

    it(
      "files under its key's HMAC, before a retry runs it, an answer a restored copy kept by the key itself",
      async () => {
        await earlierAnswerScenario("at start");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "files under its key's HMAC an answer a copy restored under the running app kept by the key itself",
      async () => {
        await earlierAnswerScenario("hot");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "deletes, from a copy restored from before forgetTenant, the fields kept in the clear before anything reads them",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock, {
          registry: clear,
        });
        await write(first, "ana");
        expect(
          await (
            first.queries as unknown as Record<string, (payload: unknown) => unknown>
          ).contactOf?.({ customerId: "ana" }),
        ).toEqual({ customerId: "ana", email: valuesOf("ana").email });
        await target.backUp();
        await first.app.forgetTenant(DEFAULT_TENANT);
        await expectTenantForgotten(openedAs(first.app.config.storage), {
          values: [valuesOf("ana").email],
        });
        await first.app.stop();

        const storage = await target.restore();
        clock.advance(60_000);
        const restored = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock, {
          registry: clear,
        });
        await expect(
          (
            restored.queries as unknown as Record<string, (payload: unknown) => unknown>
          ).contactOf?.({ customerId: "ana" }),
        ).rejects.toThrow(TenantForgottenError);
        await expectTenantForgotten(openedAs(restored.app.config.storage), {
          values: [valuesOf("ana").email],
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "keeps a copy restored from before forgetTenant unreadable, and forgets the tenant again in it at the start",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await write(first, "bob");
        await target.backUp();
        await first.app.forgetTenant(DEFAULT_TENANT);
        await first.app.stop();

        const storage = await target.restore();
        const values = ["ana", "bob"].flatMap((person) => Object.values(valuesOf(person)));
        // The copy still holds the persons' keys, wrapped under a tenant key that no longer exists,
        // and the read model's fields not marked personal, in the clear until the next start.
        // A file encrypted under the tenant's keys opens to nothing but the app.
        if (storage.encryptedFile === undefined) {
          const before = await expectTenantForgotten(storage, { values }).catch(
            (error: unknown) => error,
          );
          expect(before).toBeInstanceOf(TenantNotForgottenError);
          const { found, problems } = before as TenantNotForgottenError;
          expect(problems).toEqual(
            expect.arrayContaining([expect.stringContaining("is not marked forgotten")]),
          );
          expect(found.map(({ value }) => value).sort()).toEqual(
            ["ana", "bob"]
              .flatMap((person) => [valuesOf(person).email, valuesOf(person).name])
              .sort(),
          );
          expect(new Set(found.map(({ store }) => store)).size).toBe(1);
          expect(found[0]?.store).toMatch(/rm_customers$/);
        }

        clock.advance(60_000);
        const restored = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await expect(
          restored.commands.registerCustomer?.({
            customerId: "cy",
            email: valuesOf("cy").email,
            name: valuesOf("cy").name,
          }),
        ).rejects.toThrow(TenantForgottenError);
        await expect(restored.app.exportPersonalData("ana")).rejects.toThrow(TenantForgottenError);
        await expectTenantForgotten(openedAs(restored.app.config.storage), { values });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "reconciles at the start after a restore whatever the copy says of a failed reconciliation",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        // A reconciliation fails, and its hold is in the copy.
        state.failing = true;
        clock.advance(RECONCILE_EVERY_MS);
        await first.app.runUntilIdle();
        expect(await first.app.getLag()).toMatchObject({ forgetLedger: { reconciled: false } });
        await target.backUp();
        state.failing = false;
        const anaForgotten = (await first.app.forget("ana")).eventIds;
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(restored.app, "ana")).toEqual(anaForgotten);
        expect(await restored.app.getLag()).toMatchObject({ forgetLedger: { reconciled: true } });
        await expectForgottenIn(restored, "ana");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "forgets again whoever a restore under an instance that runs no worker brings back",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const web = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock, {
          role: "web",
        });
        web.app.start();
        await write(web, "ana");
        await target.backUp();
        const anaForgotten = (await web.app.forget("ana")).eventIds;
        await web.app.catchUpReadModels();
        await expectForgottenIn(web, "ana");
        await target.restore(openedAs(web.app.config.storage));
        clock.advance(GENERATION_INTERVAL_MS);
        // Its watch reconciles and catches the read models up by itself.
        await vi.waitFor(
          async () => {
            expect(await forgettings(web.app, "ana")).toEqual(anaForgotten);
            await expectForgottenIn(web, "ana");
          },
          { timeout: BACKGROUND_WAIT_MS },
        );
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "starts over when an operator says a database without a forget ledger was restored, which bounda forget --from then forgets again",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, null, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        await first.app.forget("ana");
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, null, BEFORE_ROTATION, clock);
        // Nothing outside the database says it went back; a restore made in place counted itself,
        // and declaring it after counts it no more, nor does declaring it again.
        expect((await restored.app.status()).restoresFound).toBeLessThanOrEqual(1);
        await restored.app.restored();
        expect((await restored.app.status()).restoresFound).toBe(1);
        await restored.app.restored();
        expect((await restored.app.status()).restoresFound).toBe(1);
        expect(await restored.app.forgetAgain([{ personId: "ana" }])).toEqual(["ana"]);
        await restored.app.runUntilIdle();
        await expectForgottenIn(restored, "ana");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "commits at the restored start a forgetting the ledger recorded before a commit that never happened",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        const written = await openedAs(first.app.config.storage).createStorage();
        const key = await written.personalKeys.get("ana", "default");
        await written.close();
        // What a forget records before it commits, left alone by a process that stopped in between.
        const intention = {
          personId: "ana",
          categories: null,
          eventId: "019a6b1e-0000-7000-8000-00000000a7a0",
          forgottenAt: clock.now().toISOString(),
          reason: "requested" as const,
          fingerprints: key === null ? [] : [key.fingerprint],
        };
        await opened[0]?.append([intention]);
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(restored.app, "ana")).toEqual([intention.eventId]);
        await expectForgottenIn(restored, "ana");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // What a forget records before it commits: an intention, until the stream copies its commit.
    const intentionOf = async (started: Started, person: string, at: Date) => {
      const written = await openedAs(started.app.config.storage).createStorage();
      const key = await written.personalKeys.get(person, "default");
      await written.close();
      return {
        personId: person,
        categories: null,
        eventId: `019a6b1e-0000-7000-8000-${person.padStart(12, "0")}`,
        forgottenAt: at.toISOString(),
        reason: "requested" as const,
        fingerprints: key === null ? [] : [key.fingerprint],
        committed: false as const,
      };
    };

    it(
      "commits at the next start, counting no restore, a forgetting whose commit never happened",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        // Left alone by a process that stopped between the intention and the commit.
        const intention = await intentionOf(first, "ana", clock.now());
        await opened[0]?.append([intention]);
        await first.app.stop();

        clock.advance(FORGET_LEDGER_GRACE_MS);
        const next = await start(target.storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(next.app, "ana")).toEqual([intention.eventId]);
        await expectForgottenIn(next, "ana");
        expect((await next.app.status()).restoresFound).toBe(0);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "commits on a periodic round, counting no restore, a forgetting whose commit never happened",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        const intention = await intentionOf(first, "ana", clock.now());
        await opened[0]?.append([intention]);
        clock.advance(RECONCILE_EVERY_MS);
        await first.app.runUntilIdle();
        expect(await forgettings(first.app, "ana")).toEqual([intention.eventId]);
        await expectForgottenIn(first, "ana");
        expect((await first.app.status()).restoresFound).toBe(0);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts a restore, at the next start, for a forgetting whose commit the ledger holds and the database lost",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        // What the stream copies once a forgetting committed, of a database that lost it since
        // while nothing told the ledger's mark.
        const { committed: _, ...copied } = await intentionOf(first, "ana", clock.now());
        await opened[0]?.append([copied]);
        await first.app.stop();

        clock.advance(FORGET_LEDGER_GRACE_MS);
        const next = await start(target.storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(next.app, "ana")).toEqual([copied.eventId]);
        expect((await next.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts no restore more for a forgetting the ledger takes only after the restore that lost it was counted",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        // A forgetting committed after the copy, whose copy to the ledger, given up for its
        // timeout, lands only once the restore that lost it is counted and reconciled.
        const { committed: _, ...late } = await intentionOf(first, "ana", clock.now());
        clock.advance(GENERATION_INTERVAL_MS);
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, definition, BEFORE_ROTATION, clock);
        expect((await restored.app.status()).restoresFound).toBe(1);
        await opened.at(-1)?.append([late]);
        await restored.app.stop();
        clock.advance(FORGET_LEDGER_GRACE_MS);
        const next = await start(storage, definition, BEFORE_ROTATION, clock);
        await next.app.runUntilIdle();
        expect(await forgettings(next.app, "ana")).toEqual([late.eventId]);
        expect((await next.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts a declared restore once, however often the declaration is made again after it failed or went through",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        // On a ledger whose reads lag, a declaration that counts nothing answers once they show
        // every mark raised before the start: the clock passes their delay as it waits.
        const declared = (started: Started, options?: { readonly again?: boolean }) => {
          const answer = started.app.restored(options);
          clock.advance(LAG_MS);
          return answer;
        };
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await first.app.stop();

        // A copy of the database as it stood, which nothing but the operator can tell apart.
        const restored = await start(target.storage, definition, BEFORE_ROTATION, clock);
        expect((await restored.app.status()).restoresFound).toBe(0);
        // The mark the declaration raises is down: it fails, and counts nothing it cannot finish.
        state.marksFailing = true;
        await expect(restored.app.restored()).rejects.toThrow("the ledger's marks are down");
        state.marksFailing = false;
        expect(await restored.app.restored()).toEqual({ counted: true });
        expect((await restored.app.status()).restoresFound).toBe(1);
        expect(await declared(restored)).toEqual({ counted: false });
        await restored.app.stop();
        // Run again by an operator, as `bounda restored` is, before the database moved on.
        const again = await start(target.storage, definition, BEFORE_ROTATION, clock);
        expect(await declared(again)).toEqual({ counted: false });
        expect((await again.app.status()).restoresFound).toBe(1);
        // Told the database is a copy taken right then, it counts it.
        expect(await again.app.restored({ again: true })).toEqual({ counted: true });
        expect((await again.app.status()).restoresFound).toBe(2);
        expect(await declared(again)).toEqual({ counted: false });
        await expectReadable(again, "ana");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // Where the database stands, as an intention keeps it.
    const reachedOf = async (started: Started) => {
      const written = await openedAs(started.app.config.storage).createStorage();
      try {
        return {
          position: await written.eventStore.lastPosition(),
          generation: await written.checkpointStore.get(RESTORE_GENERATION),
        };
      } finally {
        await written.close();
      }
    };

    it.skipIf(!hot)(
      "counts once, at the next start, a restore under the running app whose only witness stopped before it looked again",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        // The copy lacks bob, whom only this instance saw, and nothing else.
        await write(first, "bob");
        await target.restore(openedAs(first.app.config.storage));
        await first.app.stop();
        const next = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        expect((await next.app.status()).restoresFound).toBe(1);
        await next.app.stop();
        const again = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        expect((await again.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "counts, at a pass of an instance that saw nothing of what a restore under it lost, the restore another instance's stop left in the ledger",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        const second = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await second.app.runUntilIdle();
        await target.backUp();
        await write(first, "bob");
        await target.restore(openedAs(first.app.config.storage));
        await first.app.stop();
        await second.app.runUntilIdle();
        expect((await second.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts once a restore found while the ledger's entries could not be read, which a later start reconciles",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        const anaForgotten = (await first.app.forget("ana")).eventIds;
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        state.entriesFailing = true;
        const found = await start(storage, definition, BEFORE_ROTATION, clock);
        expect((await found.app.status()).restoresFound).toBe(1);
        await found.app.stop();
        state.entriesFailing = false;
        const reconciled = await start(storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(reconciled.app, "ana")).toEqual(anaForgotten);
        expect((await reconciled.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts at the start a restore that lost a forgetting committed a moment before, while the ledger's mark took nothing",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        state.marksFailing = true;
        await first.app.forget("ana");
        await first.app.stop();
        state.marksFailing = false;

        // A committed entry's commit came before it: no grace waits for it, so a forgetting made
        // again before the grace ended cannot hide the restore.
        const storage = await target.restore();
        const restored = await start(storage, definition, BEFORE_ROTATION, clock);
        expect((await restored.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts every restore found, past one counted on a copy a later restore took back",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        await write(first, "bob");
        await first.app.stop();
        const once = await start(
          await target.restore(),
          target.forgetLedger,
          BEFORE_ROTATION,
          clock,
        );
        expect((await once.app.status()).restoresFound).toBe(1);
        await once.app.stop();
        // The same copy again: it holds no count, and the ledger holds one.
        const twice = await start(
          await target.restore(),
          target.forgetLedger,
          BEFORE_ROTATION,
          clock,
        );
        expect((await twice.app.status()).restoresFound).toBe(2);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts a restore that lost a committed forgetting whose person an earlier intention forgot again first",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        // A forgetting of ana that never committed, before the one that did.
        const earlier = await intentionOf(first, "ana", new Date(START.getTime() - 2 * 60_000));
        await opened[0]?.append([earlier]);
        state.marksFailing = true;
        await first.app.forget("ana");
        await first.app.stop();
        state.marksFailing = false;

        clock.advance(FORGET_LEDGER_GRACE_MS);
        const restored = await start(await target.restore(), definition, BEFORE_ROTATION, clock);
        expect(await forgettings(restored.app, "ana")).toEqual([earlier.eventId]);
        expect((await restored.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts at the start a restore an intention written past the copy tells, though it forgets nobody again yet",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await target.backUp();
        await write(first, "bob");
        // Left by a process that stopped between the intention and the commit, past the copy.
        await opened[0]?.append([
          { ...(await intentionOf(first, "bob", clock.now())), reached: await reachedOf(first) },
        ]);
        state.marksFailing = true;
        await first.app.stop();
        state.marksFailing = false;

        const restored = await start(await target.restore(), definition, BEFORE_ROTATION, clock);
        expect((await restored.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts, on a ledger whose reads lag, a copy restored right after the mark passed it, once the reads show the mark, and once only",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const ledger = laggingLedger(target.forgetLedger, clock);
        const first = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        // Its reads show every mark raised before it started: the generation moves from here.
        clock.advance(LAG_MS);
        await first.app.runUntilIdle();
        await target.backUp();
        await write(first, "ana");
        clock.advance(GENERATION_INTERVAL_MS);
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, ledger, BEFORE_ROTATION, clock);
        // Found at start only by an adapter that counts it where it puts the copy back.
        expect((await restored.app.status()).restoresFound).toBeLessThanOrEqual(1);
        // It writes and looks while its reads cannot show the mark, and passes nothing it lacks.
        await write(restored, "bob");
        clock.advance(GENERATION_INTERVAL_MS);
        await restored.app.runUntilIdle();
        clock.advance(LAG_MS);
        await restored.app.runUntilIdle();
        expect((await restored.app.status()).restoresFound).toBe(1);
        clock.advance(LAG_MS);
        await restored.app.runUntilIdle();
        await restored.app.stop();
        const next = await start(storage, ledger, BEFORE_ROTATION, clock);
        clock.advance(LAG_MS);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts once, on a ledger whose reads lag, a copy found at start behind a mark its reads show, when a higher one raised before shows later",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const ledger = laggingLedger(target.forgetLedger, clock);
        const first = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        clock.advance(LAG_MS);
        await first.app.runUntilIdle();
        await target.backUp();
        await write(first, "ana");
        clock.advance(GENERATION_INTERVAL_MS);
        await first.app.runUntilIdle();
        // That mark shows by the restore; the ones raised after it do not.
        clock.advance(LAG_MS);
        for (const person of ["bob", "cy"]) {
          await write(first, person);
          clock.advance(GENERATION_INTERVAL_MS);
          await first.app.runUntilIdle();
        }
        await first.app.stop();

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, ledger, BEFORE_ROTATION, clock);
        expect((await restored.app.status()).restoresFound).toBe(1);
        clock.advance(LAG_MS);
        await restored.app.runUntilIdle();
        expect((await restored.app.status()).restoresFound).toBe(1);
        await restored.app.stop();
        const next = await start(storage, ledger, BEFORE_ROTATION, clock);
        clock.advance(LAG_MS);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts, on a ledger whose reads lag, a restore declared past one declared a moment before that its reads do not show",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const ledger = laggingLedger(target.forgetLedger, clock);
        const first = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        await target.backUp();
        await first.app.restored();
        await first.app.stop();

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, ledger, BEFORE_ROTATION, clock);
        // An adapter that counts the restore where it puts the copy back counts past the database;
        // a declaration then counts nothing more, once the reads show every mark.
        const declared = restored.app.restored();
        clock.advance(LAG_MS);
        await declared;
        await restored.app.runUntilIdle();
        expect((await restored.app.status()).restoresFound).toBe(2);
        await restored.app.stop();
        const next = await start(storage, ledger, BEFORE_ROTATION, clock);
        clock.advance(LAG_MS);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(2);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts, on a ledger whose reads lag, a restore declared before the reads show the count made since a copy of where handling the last one left the database",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const ledger = laggingLedger(target.forgetLedger, clock);
        const first = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        expect(await first.app.restored()).toEqual({ counted: true });
        // Where handling that declaration left the database.
        await target.backUp();
        await first.app.stop();
        const between = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        expect(await between.app.restored({ again: true })).toEqual({ counted: true });
        await between.app.stop();

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, ledger, BEFORE_ROTATION, clock);
        // Its reads show neither count yet: the declaration waits until they do.
        const declared = restored.app.restored();
        clock.advance(LAG_MS);
        // An adapter that counts the restore where it puts the copy back counted it at start.
        expect([{ counted: true }, { counted: false }]).toContainEqual(await declared);
        expect((await restored.app.status()).restoresFound).toBe(3);
        expect(await restored.app.restored()).toEqual({ counted: false });
        await restored.app.stop();
        const next = await start(storage, ledger, BEFORE_ROTATION, clock);
        clock.advance(LAG_MS);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(3);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts, on a ledger whose reads lag, a restore that lost a forgetting its reads did not show yet, though the person was forgotten again before they did",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const ledger = laggingLedger(target.forgetLedger, clock);
        const first = await start(target.storage, ledger, BEFORE_ROTATION, clock);
        await write(first, "ana");
        clock.advance(LAG_MS);
        await first.app.runUntilIdle();
        await target.backUp();
        // Committed, and lost with the copy; the instance is gone before it looks again.
        await first.app.forget("ana");

        const storage = await target.restore();
        clock.advance(1);
        const restored = await start(storage, ledger, BEFORE_ROTATION, clock);
        // Forgotten again before the reads show the first forgetting, which then reads as applied
        // to nobody.
        await restored.app.forget("ana");
        await restored.app.stop();
        clock.advance(LAG_MS);
        const next = await start(storage, ledger, BEFORE_ROTATION, clock);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(1);
        clock.advance(LAG_MS);
        await next.app.runUntilIdle();
        expect((await next.app.status()).restoresFound).toBe(1);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts, without a ledger, a restore an operator declares of a copy taken after the last one was handled",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, null, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await first.app.restored();
        expect((await first.app.status()).restoresFound).toBe(1);
        // Written to, copied, written to again, then put back to the copy.
        await write(first, "bob");
        await target.backUp();
        await write(first, "cy");
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, null, BEFORE_ROTATION, clock);
        await restored.app.restored();
        expect((await restored.app.status()).restoresFound).toBe(2);
        await restored.app.restored();
        expect((await restored.app.status()).restoresFound).toBe(2);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "counts a restore the ledger tells after one was handled, though the database stands where that one left it",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await first.app.restored();
        expect((await first.app.status()).restoresFound).toBe(1);
        // A forgetting committed since, which the database lost while nothing told the mark.
        clock.advance(1);
        const { committed: _, ...copied } = await intentionOf(first, "ana", clock.now());
        await opened[0]?.append([copied]);
        await first.app.stop();

        clock.advance(FORGET_LEDGER_GRACE_MS);
        const next = await start(target.storage, definition, BEFORE_ROTATION, clock);
        expect(await forgettings(next.app, "ana")).toEqual([copied.eventId]);
        expect((await next.app.status()).restoresFound).toBe(2);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "restricts again whoever a restore brings back unrestricted, and lifts again whoever it brings back restricted, each change once, with its id",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const first = await start(target.storage, target.forgetLedger, BEFORE_ROTATION, clock);
        for (const person of ["ana", "bob", "cy"]) await write(first, person);
        await first.app.restrict("bob", { ground: "objection-pending" });
        await target.backUp();
        const anaRestricted = (await first.app.restrict("ana", { ground: "legal-claims" }))
          .eventIds;
        const bobLifted = (await first.app.unrestrict("bob", { notice: "given" })).eventIds;
        const cyAnnounced = (await first.app.unrestrict("cy", { notice: "given" })).eventIds;
        expect(cyAnnounced).toEqual([]);
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await restored.app.runUntilIdle();
        const changes = (await restored.app.events.read({ limit: 1_000 })).filter(
          (event) => event.aggregateType === "bounda" && event.type !== "PersonalDataForgotten",
        );
        expect(changes.map(({ id }) => id)).toEqual([
          expect.any(String),
          ...anaRestricted,
          ...bobLifted,
        ]);
        expect(await restored.queries.getCustomer?.({ customerId: "ana" })).toBeNull();
        await expectReadable(restored, "bob");
        await expectReadable(restored, "cy");
        expect((await restored.app.exportPersonalData("ana")).restrictions).toEqual([
          { ground: "legal-claims", categories: null, since: START.toISOString() },
        ]);
        await expect(
          restored.commands.confirmCustomer?.({ customerId: "ana" }),
        ).rejects.toMatchObject({ code: "PROCESSING_RESTRICTED" });
        await restored.app.stop();

        const again = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock);
        await again.app.runUntilIdle();
        expect(
          (await again.app.events.read({ limit: 1_000 })).filter(
            (event) => event.aggregateType === "bounda" && event.type !== "PersonalDataForgotten",
          ),
        ).toHaveLength(3);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "commits at the restored start a restriction the ledger recorded before a commit that never happened, and not one a later change superseded",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock);
        await write(first, "ana");
        await write(first, "bob");
        const intention = (personId: string, eventId: string, minute: number) => ({
          personId,
          categories: null,
          eventId,
          forgottenAt: new Date(START.getTime() + minute * 60_000).toISOString(),
          reason: "requested" as const,
          restriction: {
            type: "ProcessingRestricted" as const,
            payload: {
              personId,
              ground: "accuracy-contested" as const,
              categories: null,
              restrictions: [
                {
                  ground: "accuracy-contested" as const,
                  categories: null,
                  since: new Date(START.getTime() + minute * 60_000).toISOString(),
                },
              ],
            },
          },
        });
        // Ana's was left alone by a process that stopped in between; bob's was superseded by a
        // restriction and a lift committed after it, which the copy holds.
        await opened[0]?.append([
          intention("ana", "019a6b1e-0000-7000-8000-00000000a7a1", -2),
          intention("bob", "019a6b1e-0000-7000-8000-00000000a7a2", -2),
        ]);
        await first.app.restrict("bob", { ground: "objection-pending" });
        await first.app.unrestrict("bob", { notice: "given" });
        await target.backUp();
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, definition, BEFORE_ROTATION, clock);
        await restored.app.runUntilIdle();
        expect(await restored.queries.getCustomer?.({ customerId: "ana" })).toBeNull();
        await expectReadable(restored, "bob");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "does not start on a restored copy a strict ledger cannot read, and applies the whole restore once it can",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        const strict = { strict: true };
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock, strict);
        await write(first, "ana");
        await write(first, "bob");
        await target.backUp();
        const anaForgotten = (await first.app.forget("ana")).eventIds;
        const bobForgotten = (await first.app.forget("bob")).eventIds;
        await first.app.runUntilIdle();
        await first.app.stop();

        const storage = await target.restore();
        state.failing = true;
        await expect(start(storage, definition, BEFORE_ROTATION, clock, strict)).rejects.toThrow(
          ForgetLedgerUnreconciledError,
        );
        state.failing = false;
        const restored = await start(storage, definition, BEFORE_ROTATION, clock, strict);
        expect(await forgettings(restored.app, "ana")).toEqual(anaForgotten);
        expect(await forgettings(restored.app, "bob")).toEqual(bobForgotten);
        await expectForgottenIn(restored, "ana");
        await expectForgottenIn(restored, "bob");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "forgets again only the categories a partial forgetting named, and keeps readable what the law keeps",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const open = async (storage: Adapter) => {
          const app = await createApp({
            registry: categorized,
            config: {
              storage,
              runtime: {
                personalData: {
                  keyWrapper: BEFORE_ROTATION,
                  tenantKeys,
                  forgetLedger: { store: target.forgetLedger, reconcileEvery: RECONCILE_EVERY_MS },
                },
              },
            },
            clock,
            env,
          });
          stops.push(() => app.stop());
          return app;
        };
        const read = async (app: BoundaApp, person: string) =>
          (await app.exportPersonalData(person)).events[0]?.data;
        const first = await open(target.storage);
        const commands = first.commands as unknown as Commands;
        for (const person of ["ana", "bob"]) {
          await commands.billCustomer?.({ customerId: person, ...billOf(person) });
        }
        await target.backUp();
        // Ana withdraws her consent to the newsletter; bob is forgotten as a whole.
        const anaForgotten = (await first.forget("ana", { categories: ["marketing"] })).eventIds;
        const bobForgotten = (await first.forget("bob")).eventIds;
        await first.runUntilIdle();
        await first.stop();

        const storage = await target.restore();
        const restored = await open(storage);
        expect(await forgettings(restored, "ana")).toEqual(anaForgotten);
        expect(await forgettings(restored, "bob")).toEqual(bobForgotten);
        const ana = billOf("ana");
        const bob = billOf("bob");
        expect(await read(restored, "ana")).toEqual({
          newsletter: null,
          taxId: ana.taxId,
          name: ana.name,
        });
        expect(await read(restored, "bob")).toEqual({
          newsletter: null,
          taxId: bob.taxId,
          name: null,
        });
        await expectForgotten(openedAs(restored.config.storage), "ana", {
          categories: ["marketing"],
          values: [ana.newsletter],
        });
        await expectForgotten(openedAs(restored.config.storage), "bob", {
          values: [bob.newsletter, bob.name],
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "keeps a read model restored in its own database from before a forgetting unreadable for that person, with no projection of the forgetting",
      async () => {
        const storageTarget = await create();
        const rowsTarget = await create();
        const clock = createFixedClock(START);
        const open = async (rows: Adapter): Promise<BoundaApp> => {
          const app = await createApp({
            registry: sealed,
            config: {
              storage: storageTarget.storage,
              readModels: { sealedCustomers: rows },
              runtime: {
                personalData: { keyWrapper: BEFORE_ROTATION, tenantKeys },
                policies: { retry: { strategy: "none" } },
              },
            },
            clock,
            env,
          });
          stops.push(() => app.stop());
          return app;
        };
        const { email, name } = valuesOf("ana");
        const first = await open(rowsTarget.storage);
        await (first.commands as unknown as Commands).registerCustomer?.({
          customerId: "ana",
          email,
          name,
        });
        await first.runUntilIdle();
        const queries = (app: BoundaApp) => app.queries as unknown as Queries;
        expect(await queries(first).sealedCustomer?.({ customerId: "ana" })).toEqual({
          customerId: "ana",
          email,
        });
        await rowsTarget.backUp();
        await first.forget("ana");
        await first.runUntilIdle();
        await first.stop();

        const rows = await rowsTarget.restore();
        if (rows.encryptedFile === undefined)
          await expectForgotten(rows, "ana", { values: [email] });
        const restored = await open(rows);
        await restored.catchUpReadModels();
        expect(await queries(restored).sealedCustomer?.({ customerId: "ana" })).toEqual({
          customerId: "ana",
          email: null,
        });
        expect(await queries(restored).sealedByEmail?.({ email })).toBeNull();
        await expectForgotten(openedAs(restored.config.readModels.sealedCustomers), "ana", {
          values: [email],
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "seals again, with its id, a redaction a restore undid, so the old value reads nowhere once reconciled",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const options = { registry: sealed };
        const first = await start(
          target.storage,
          target.forgetLedger,
          BEFORE_ROTATION,
          clock,
          options,
        );
        await write(first, "ana");
        await write(first, "bob");
        await target.backUp();
        const { email } = valuesOf("ana");
        const wrong = await holding(first.app, "ana", email);
        expect(wrong.map(({ type }) => type)).toContain("CustomerRegistered");
        const redacted = (await first.app.redact("ana", { events: wrong })).eventIds;
        await first.app.runUntilIdle();
        await expectRedactedIn(first, "ana", email);
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock, options);
        await restored.app.runUntilIdle();
        expect(await redactions(restored.app, "ana")).toEqual(redacted);
        await expectRedactedIn(restored, "ana", email);
        expect(await restored.queries.sealedCustomer?.({ customerId: "bob" })).toEqual({
          customerId: "bob",
          email: valuesOf("bob").email,
        });
        expect(await restored.queries.handleOf?.({ customerId: "bob" })).toEqual({
          customerId: "bob",
          handle: handleOf(valuesOf("bob").email),
        });
        await restored.app.stop();

        const again = await start(storage, target.forgetLedger, BEFORE_ROTATION, clock, options);
        await again.app.runUntilIdle();
        expect(await redactions(again.app, "ana")).toEqual(redacted);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "commits at the restored start a redaction the ledger recorded before a commit that never happened",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, opened } = faultyLedger(target.forgetLedger);
        const options = { registry: sealed };
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock, options);
        await write(first, "ana");
        const { email } = valuesOf("ana");
        const wrong = await holding(first.app, "ana", email);
        const eventId = "019a6b1e-0000-7000-8000-00000000ad01";
        await opened[0]?.append([
          {
            personId: "ana",
            categories: null,
            eventId,
            forgottenAt: new Date(START.getTime() - 2 * 60_000).toISOString(),
            reason: "requested",
            redaction: { events: wrong },
          },
        ]);
        await target.backUp();
        await first.app.stop();

        const storage = await target.restore();
        const restored = await start(storage, definition, BEFORE_ROTATION, clock, options);
        await restored.app.runUntilIdle();
        expect(await redactions(restored.app, "ana")).toEqual([eventId]);
        await expectRedactedIn(restored, "ana", email);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // An app whose read model of contacts, emails in the clear, lives in a database of its own.
    const openSplit = async (
      storage: Adapter,
      rows: Adapter,
      forgetLedger: ForgetLedgerSource,
      clock: Clock,
      { strict = false }: { readonly strict?: boolean } = {},
    ): Promise<Started> => {
      const app = await createApp({
        registry: clear,
        config: {
          storage,
          readModels: { contacts: rows },
          runtime: {
            personalData: {
              keyWrapper: BEFORE_ROTATION,
              tenantKeys,
              forgetLedger: { store: forgetLedger, reconcileEvery: RECONCILE_EVERY_MS, strict },
            },
            policies: { retry: { strategy: "none" } },
          },
        },
        clock,
        env,
      });
      stops.push(() => app.stop());
      return {
        app,
        commands: app.commands as unknown as Commands,
        queries: app.queries as unknown as Queries,
      };
    };

    const contactOf = (
      { app }: Started,
      person: string,
      options?: { readonly includeRestricted: "legal-claims" },
    ): Promise<unknown> =>
      (
        app.queries as unknown as Record<
          string,
          (payload: unknown, options?: unknown) => Promise<unknown>
        >
      ).contactOf?.({ customerId: person }, options) ?? Promise.resolve(undefined);

    // ana and bob registered before the copy of the stream; eve after it, ana was forgotten and bob
    // restricted after it: the read model's database holds what the stream the restore undoes
    // wrote, and the copy's positions are taken again by what the ledger commits once more.
    const aheadOfTheCopy = async (strict: boolean) => {
      const storageTarget = await create();
      const rowsTarget = await create();
      const clock = createFixedClock(START);
      const first = await openSplit(
        storageTarget.storage,
        rowsTarget.storage,
        storageTarget.forgetLedger,
        clock,
        { strict },
      );
      for (const person of ["ana", "bob"]) await write(first, person);
      await storageTarget.backUp();
      await write(first, "eve");
      await first.app.forget("ana");
      await first.app.restrict("bob", { ground: "accuracy-contested" });
      await first.app.runUntilIdle();
      expect(await contactOf(first, "eve")).toEqual({
        customerId: "eve",
        email: valuesOf("eve").email,
      });
      return { storageTarget, rowsTarget, clock, first };
    };

    // What the read model serves once the stream is restored: nobody the copy does not hold, nobody
    // forgotten since, and nobody restricted since unless a basis is named.
    const expectContactsOfTheCopy = async (restored: Started): Promise<void> => {
      expect(await contactOf(restored, "eve")).toBeNull();
      expect(await contactOf(restored, "ana")).toBeNull();
      expect(await contactOf(restored, "bob")).toBeNull();
      expect(await contactOf(restored, "bob", { includeRestricted: "legal-claims" })).toEqual({
        customerId: "bob",
        email: valuesOf("bob").email,
      });
      await expectForgotten(openedAs(restored.app.config.readModels.contacts), "ana", {
        values: [valuesOf("ana").email],
      });
      await expectForgotten(openedAs(restored.app.config.readModels.contacts), "eve", {
        values: [valuesOf("eve").email],
      });
    };

    it(
      "projects again from the start, before it serves, a read model in a database of its own that holds what the stream a restore undid wrote",
      async () => {
        const { storageTarget, rowsTarget, clock, first } = await aheadOfTheCopy(false);
        await first.app.stop();
        const storage = await storageTarget.restore();
        const restored = await openSplit(
          storage,
          rowsTarget.storage,
          storageTarget.forgetLedger,
          clock,
        );
        await expectContactsOfTheCopy(restored);
        await restored.app.unrestrict("bob", { notice: "given" });
        await restored.app.runUntilIdle();
        expect(await contactOf(restored, "bob")).toEqual({
          customerId: "bob",
          email: valuesOf("bob").email,
        });
        await write(restored, "fay");
        expect(await contactOf(restored, "fay")).toEqual({
          customerId: "fay",
          email: valuesOf("fay").email,
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "refuses, in a strict app, a query read from a stream restored under it, and serves the read model in a database of its own once projected again",
      async () => {
        const { storageTarget, first } = await aheadOfTheCopy(true);
        await storageTarget.restore(openedAs(first.app.config.storage));
        await expect(first.app.exportPersonalData("bob")).rejects.toMatchObject({
          code: "RESTORE_UNRECONCILED",
        });
        // Settled before the refusal: the ledger reconciled with the copy, the read model holding
        // the stream the restore undid projected again from the start.
        await expectContactsOfTheCopy(first);
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    // ana registered and was projected, the read model's database was copied, and ana forgotten.
    const behindTheStream = async (strict: boolean) => {
      const storageTarget = await create();
      const rowsTarget = await create();
      const clock = createFixedClock(START);
      const first = await openSplit(
        storageTarget.storage,
        rowsTarget.storage,
        storageTarget.forgetLedger,
        clock,
        { strict },
      );
      await write(first, "ana");
      await write(first, "bob");
      await rowsTarget.backUp();
      await first.app.forget("ana");
      await first.app.runUntilIdle();
      expect(await contactOf(first, "ana")).toBeNull();
      return { storageTarget, rowsTarget, clock, first };
    };

    it(
      "catches up, before it serves, a read model in a database of its own restored from before a forgetting",
      async () => {
        const { storageTarget, rowsTarget, clock, first } = await behindTheStream(false);
        await first.app.stop();
        const rows = await rowsTarget.restore();
        const restored = await openSplit(
          storageTarget.storage,
          rows,
          storageTarget.forgetLedger,
          clock,
        );
        expect(await contactOf(restored, "ana")).toBeNull();
        expect(await contactOf(restored, "bob")).toEqual({
          customerId: "bob",
          email: valuesOf("bob").email,
        });
        await expectForgotten(openedAs(restored.app.config.readModels.contacts), "ana", {
          values: [valuesOf("ana").email],
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it(
      "serves nothing of a read model in a database of its own restored from before a forgetting while the tenant is frozen, and catches it up once it thaws",
      async () => {
        const { storageTarget, rowsTarget, clock, first } = await behindTheStream(false);
        const keyed = openedAs(first.app.config.storage);
        await first.app.stop();
        const rows = await rowsTarget.restore();
        // Frozen once the copy is back, as a restore refuses a frozen tenant.
        const storage = await keyed.createStorage();
        await storage.fence.set({
          state: "frozen",
          tenant: DEFAULT_TENANT,
          since: clock.now().toISOString(),
        });
        const restored = await openSplit(
          storageTarget.storage,
          rows,
          storageTarget.forgetLedger,
          clock,
        );
        await expect(contactOf(restored, "ana")).rejects.toBeInstanceOf(ReadModelRestoringError);
        await restored.app.unfreezeTenant(DEFAULT_TENANT);
        await restored.app.runUntilIdle();
        expect(await contactOf(restored, "ana")).toBeNull();
        expect(await contactOf(restored, "bob")).toEqual({
          customerId: "bob",
          email: valuesOf("bob").email,
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "refuses, in a strict app, a query of a read model whose database of its own was restored under it from before a forgetting, until it caught up",
      async () => {
        const { rowsTarget, first } = await behindTheStream(true);
        await rowsTarget.restore(openedAs(first.app.config.readModels.contacts));
        const refused = contactOf(first, "ana");
        await expect(refused).rejects.toBeInstanceOf(ReadModelRestoringError);
        await expect(refused).rejects.toMatchObject({ readModel: "contacts" });
        await first.app.runUntilIdle();
        expect(await contactOf(first, "ana")).toBeNull();
        expect(await contactOf(first, "bob")).toEqual({
          customerId: "bob",
          email: valuesOf("bob").email,
        });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );

    it.skipIf(!hot)(
      "refuses every read of a strict app while the ledger cannot be reconciled with a restore under it, and serves once it is",
      async () => {
        const target = await create();
        const clock = createFixedClock(START);
        const { definition, state } = faultyLedger(target.forgetLedger);
        const first = await start(target.storage, definition, BEFORE_ROTATION, clock, {
          strict: true,
        });
        await write(first, "ana");
        await target.backUp();
        await first.app.forget("ana");
        await first.app.runUntilIdle();
        state.failing = true;
        await target.restore(openedAs(first.app.config.storage));
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const refused = first.queries.getCustomer?.({ customerId: "ana" });
          await expect(refused).rejects.toBeInstanceOf(RestoreUnreconciledError);
          await expect(refused).rejects.toMatchObject({
            cause: { message: "the ledger is down" },
          });
        }
        // An export of nobody reads the header alone, and a stream hands out nothing.
        await expect(first.app.exportPersonalData("nobody")).rejects.toBeInstanceOf(
          RestoreUnreconciledError,
        );
        await expect(first.app.streamPersonalData("nobody")).rejects.toBeInstanceOf(
          RestoreUnreconciledError,
        );
        // What the runtime keeps of handlers that failed opens personal data as a query does.
        await expect(first.app.deadLetters.list()).rejects.toBeInstanceOf(RestoreUnreconciledError);
        await expect(first.app.subscriberFailures.list()).rejects.toBeInstanceOf(
          RestoreUnreconciledError,
        );
        state.failing = false;
        // The read under way when the ledger answers was read before it.
        await expect(first.queries.getCustomer?.({ customerId: "ana" })).rejects.toMatchObject({
          code: "RESTORE_UNRECONCILED",
        });
        expect(await first.queries.getCustomer?.({ customerId: "ana" })).toBeNull();
        await expectForgottenIn(first, "ana");
      },
      RESTORE_CASE_TIMEOUT_MS,
    );
  });
};
