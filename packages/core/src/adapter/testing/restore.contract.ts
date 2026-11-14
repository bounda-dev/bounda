import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRole } from "../../config/types.ts";
import { type Clock, createFixedClock } from "../../contracts/clock.ts";
import { ForgetLedgerUnreconciledError, ValidationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { type BoundaApp, createApp } from "../../kernel/app.ts";
import {
  defineForgetLedger,
  type ForgetLedgerSource,
} from "../../kernel/personal-data/forget-ledger.ts";
import type { KeyWrapperDefinition } from "../../kernel/personal-data/key-wrapper.ts";
import { masterKey } from "../../kernel/personal-data/master-key.ts";
import { GENERATION_INTERVAL_MS } from "../../kernel/shared/restores.ts";
import type { PersonalDataForgottenEvent } from "../../modules/bounda-events.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { expectForgotten } from "../../testing/expect-forgotten.ts";
import type { Adapter } from "../adapter.ts";
import type { ForgetLedger } from "../storage/forget-ledger.ts";
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
   * contract's `hot` is `true`, and after it stopped otherwise.
   */
  restore(): Promise<Adapter>;
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
            payload: ({ z }: PayloadArgs) =>
              z.object({ customerId: z.string(), email: z.string(), name: z.string() }),
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
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string() }),
            rejections: ({ state }: { state: CustomerState }) => ({
              NotYet: `${state.email ?? "This customer"} cannot be confirmed yet`,
            }),
            handler: ({ reject }: { reject: (name: "NotYet") => never }) => reject("NotYet"),
          },
        },
        noteCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), note: personal(z.string()) }),
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
          email: f.string(),
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

// The customers with their email sealed at rest, found by its blind index, and no projection of
// the forgetting: nothing but the key forgets them.
const sealed = {
  ...registry,
  readModels: {
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
            payload: ({ z }: PayloadArgs) =>
              z.object({
                customerId: z.string(),
                newsletter: z.string(),
                taxId: z.string(),
                name: z.string(),
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
    categories: {
      marketing: { basis: "consent", retention: "730d" },
      invoices: { basis: "legal-obligation", retention: "6y" },
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
  const state = { failing: false };
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
        return inner.read(readArgs);
      },
      readMark: async (name) => {
        down();
        return inner.readMark(name);
      },
      raiseMark: async (name, value) => {
        down();
        return inner.raiseMark(name, value);
      },
    };
  });
  return { definition, state, opened };
};

/**
 * What every adapter must guarantee when its database is restored from a backup, with the app
 * running or at its next start: nobody forgotten after the copy was taken can be read again
 * anywhere (events, read models, snapshots, idempotency records, scheduled commands, dead letters,
 * process state, export, the database's own rows), and the app goes on working. Call it inside a
 * `describe` of the adapter's test file.
 */
export const restoreContract: RestoreContractFunction = ({ create, hot }) => {
  describe("restore contract", () => {
    const stops: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const stop of stops.splice(0).reverse()) await stop();
    });

    const start = async (
      storage: Adapter,
      forgetLedger: ForgetLedgerSource | null,
      keyWrapper: KeyWrapperDefinition,
      clock: Clock,
      { role = "all", strict = false }: StartOptions = {},
    ): Promise<Started> => {
      const app = await createApp({
        registry,
        config: {
          storage,
          runtime: {
            role,
            personalData: {
              keyWrapper,
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
    const expectForgottenIn = async (
      storage: Adapter,
      { app, queries }: Started,
      person: string,
    ): Promise<void> => {
      await expectForgotten(storage, person, {
        values: Object.values(valuesOf(person)),
        places: {
          query: await queries.getCustomer?.({ customerId: person }),
          export: await app.exportPersonalData(person),
          "dead letters": await app.deadLetters.list(),
        },
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
        await expectForgottenIn(target.storage, rotated, person);
      }

      let storage: Adapter;
      let restored: Started;
      if (restoring === "hot") {
        storage = await target.restore();
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
        await expectForgottenIn(storage, restored, person);
      }
      expect(await forgettings(restored.app, "cy")).toEqual(cyForgotten);
      expect(await forgettings(restored.app, "eve")).toEqual([]);
      await expectForgottenIn(storage, restored, "cy");
      await expectForgottenIn(storage, restored, "eve");
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
      await expectForgottenIn(storage, restored, "dan");
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
        await expectForgottenIn(storage, restored, "ana");
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
        await expectForgottenIn(target.storage, web, "ana");
        await target.restore();
        clock.advance(GENERATION_INTERVAL_MS);
        // Its watch reconciles and catches the read models up by itself.
        await vi.waitFor(
          async () => {
            expect(await forgettings(web.app, "ana")).toEqual(anaForgotten);
            await expectForgottenIn(target.storage, web, "ana");
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
        // Nothing outside the database says it went back.
        expect((await restored.app.status()).restoresFound).toBe(0);
        await restored.app.restored();
        expect((await restored.app.status()).restoresFound).toBe(1);
        expect(await restored.app.forgetAgain([{ personId: "ana" }])).toEqual(["ana"]);
        await restored.app.runUntilIdle();
        await expectForgottenIn(storage, restored, "ana");
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
        const written = await target.storage.createStorage();
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
        await expectForgottenIn(storage, restored, "ana");
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
        await expectForgottenIn(storage, restored, "ana");
        await expectForgottenIn(storage, restored, "bob");
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
        await expectForgotten(storage, "ana", {
          categories: ["marketing"],
          values: [ana.newsletter],
        });
        await expectForgotten(storage, "bob", { values: [bob.newsletter, bob.name] });
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
                personalData: { keyWrapper: BEFORE_ROTATION },
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
        await expectForgotten(rows, "ana", { values: [email] });
        const restored = await open(rows);
        await restored.catchUpReadModels();
        expect(await queries(restored).sealedCustomer?.({ customerId: "ana" })).toEqual({
          customerId: "ana",
          email: null,
        });
        expect(await queries(restored).sealedByEmail?.({ email })).toBeNull();
        await expectForgotten(rows, "ana", { values: [email] });
      },
      RESTORE_CASE_TIMEOUT_MS,
    );
  });
};
