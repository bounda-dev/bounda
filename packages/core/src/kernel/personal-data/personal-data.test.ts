import { describe, expect, it, vi } from "vitest";
import type { Table } from "../../adapter/storage/table.ts";
import {
  ConfigurationError,
  IdempotentAnswerErasedError,
  ProcessingRestrictedError,
  ValidationError,
} from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { PersonalDataAccess } from "../../modules/audit.ts";
import type {
  PersonalDataForgottenEvent,
  ProcessingRestrictedEvent,
} from "../../modules/bounda-events.ts";
import type { RejectFunction } from "../../modules/command.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectForgotten } from "../../testing/index.ts";
import { createApp } from "../app.ts";
import { fingerprintOf } from "../command/fingerprint.ts";
import { rebuildReadModel } from "../read-model/rebuild.ts";
import { isSealed } from "./crypto.ts";
import { masterKey } from "./master-key.ts";

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
const restricted: string[] = [];
// Runs inside `remindCustomer`'s handler once, between its load and its append.
let whileDeciding: (() => Promise<unknown>) | null = null;

const registry = {
  aggregates: {
    customer: {
      state: { initialState: { email: null, name: "" } satisfies CustomerState },
      events: {
        customerRegistered: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), name: notPersonal(z.string()) }),
          evolve: ({ event }: { event: { payload: { email: string | null; name: string } } }) => ({
            email: event.payload.email,
            name: event.payload.name,
          }),
        },
        customerGreeted: {
          payload: ({ z, notPersonal }: EventPayloadArgs) =>
            z.object({ to: notPersonal(z.string().nullable()) }),
          evolve: ({ state }: { state: CustomerState }) => state,
        },
        customerReminded: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ to: personal(z.email()).optional() }),
          evolve: ({ state }: { state: CustomerState }) => state,
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                email: notPersonal(z.email()),
                name: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { email: string; name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.(command.payload)],
          },
        },
        confirmCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()) }),
            rejections: ({ state }: { state: CustomerState }) => ({
              NotYet: `${state.email ?? "This customer"} cannot be confirmed yet`,
            }),
            handler: ({ reject }: { reject: RejectFunction<"NotYet"> }) => reject("NotYet"),
          },
        },
        greetCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()) }),
            handler: ({
              state,
              events,
            }: {
              state: CustomerState;
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerGreeted?.({ to: state.email })],
          },
        },
        remindCustomer: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({ customerId: notPersonal(z.string()) }),
            handler: async ({
              state,
              events,
            }: {
              state: CustomerState;
              events: Record<string, (payload?: unknown) => unknown>;
            }) => {
              const run = whileDeciding;
              whileDeciding = null;
              await run?.();
              return [events.customerReminded?.(state.email === null ? {} : { to: state.email })];
            },
          },
        },
      },
      policies: {
        registerOnInvited: {
          module: {
            on: "Invited",
            handler: async ({
              event,
              commands,
            }: {
              event: { payload: { customerId: string; email: string } };
              commands: Record<string, (payload: unknown) => Promise<unknown>>;
            }) => {
              const { customerId, email } = event.payload;
              await commands.registerCustomer?.({ customerId, email, name: "Invited" });
              await commands.remindCustomer?.({ customerId });
            },
          },
          source: "newsletter",
        },
        boundaEraseOnPersonalDataForgotten: {
          module: {
            handler: async ({ event }: { event: PersonalDataForgottenEvent }) => {
              erased.push(event.payload.personId);
            },
          },
          source: "bounda",
        },
        boundaFlagOnProcessingRestricted: {
          module: {
            handler: async ({ event }: { event: ProcessingRestrictedEvent }) => {
              restricted.push(event.payload.personId);
            },
          },
          source: "bounda",
        },
      },
      processes: {},
    },
    newsletter: {
      events: {
        subscribed: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({ customerId: person(z.string()), email: personal(z.email()) }),
          evolve: () => ({}),
        },
        invited: {
          payload: ({ z, notPersonal }: EventPayloadArgs) =>
            z.object({ customerId: notPersonal(z.string()), email: notPersonal(z.email()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        subscribe: {
          module: {
            payload: ({ z, person, notPersonal }: EventPayloadArgs) =>
              z.object({
                newsletterId: notPersonal(z.string()),
                customerId: person(z.string()),
                email: notPersonal(z.email()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string; email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.subscribed?.(command.payload)],
          },
        },
        invite: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                newsletterId: notPersonal(z.string()),
                customerId: notPersonal(z.string()),
                email: notPersonal(z.email()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string; email: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.invited?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customerDirectory: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().optional().notPersonal(),
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

const snapshotted = {
  registry: {
    ...registry,
    aggregates: {
      ...registry.aggregates,
      customer: { ...registry.aggregates.customer, stateFingerprint: "fp" },
    },
  },
  config: { runtime: { overrides: { customer: { snapshot: { every: 1 } } } } },
};

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
    await expectForgotten(app, "c-1");
    await app.stop();
  });

  it("lets go of the keys a rebuild of its own unwrapped once it is done", async () => {
    const storage = memory();
    const env = {
      BOUNDA_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    };
    const runtime = { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } };
    const app = await createApp({ registry, config: { storage, runtime }, env });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    await app.stop();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rebuilt = await rebuildReadModel({
        registry,
        config: { storage, runtime },
        name: "customerDirectory",
        env,
      });
      expect(rebuilt).toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
    const storage = await adapter.createStorage();
    const { app } = await createTestApp({ ...snapshotted, adapter });
    await app.commands.registerCustomer(ana);
    await app.runUntilIdle();
    const stream = { aggregateType: "customer", aggregateId: "c-1" };
    const key = await storage.personalKeys.get("c-1", "default");
    expect(await storage.snapshotStore.get(stream)).toMatchObject({
      version: 1,
      persons: [{ person: "c-1", fingerprint: key?.fingerprint }],
    });
    // Sealed at rest whole, under the database's key: no copy of the store reads it.
    const sealed = (await storage.snapshotStore.get(stream))?.state ?? "";
    expect(sealed).not.toContain("ana@example.com");
    expect(Object.keys(JSON.parse(sealed) as object)).toEqual(["$sealed"]);

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

  it("seals the personal fields a stream stored in the clear, before they were marked, and drops the snapshot folded from them", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const metadata = { correlationId: "c", causationId: "c", commandId: "c", depth: 0 };
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "c-9",
      expectedVersion: 0,
      events: [
        {
          id: "e-1",
          aggregateType: "customer",
          aggregateId: "c-9",
          version: 1,
          type: "CustomerRegistered",
          payload: { email: "old@example.com", name: "Old" },
          timestamp: "2026-01-01T00:00:00.000Z",
          metadata: { ...metadata, schemaVersion: 1, system: false },
          person: null,
        },
      ],
    });
    const { app } = await createTestApp({ ...snapshotted, adapter });
    await app.commands.greetCustomer({ customerId: "c-9" });
    await app.runUntilIdle();
    const stream = { aggregateType: "customer", aggregateId: "c-9" };
    const key = await storage.personalKeys.get("c-9", "default");
    const [registered] = await storage.eventStore.readAll({ afterPosition: 0, limit: 1 });
    expect(registered).toMatchObject({
      person: "c-9",
      payload: {
        email: { $personal: { person: "c-9", key: key?.fingerprint } },
        name: "Old",
      },
    });
    expect(await storage.snapshotStore.get(stream)).toBeNull();
    const exported = async () =>
      (await app.exportPersonalData("c-9")).events.map((event) => [event.type, event.data]);
    expect(await exported()).toEqual([["CustomerRegistered", { email: "old@example.com" }]]);
    await app.forget("c-9");
    expect(await exported()).toEqual([
      ["CustomerRegistered", { email: null }],
      ["PersonalDataForgotten", {}],
    ]);
    await app.stop();
  });

  it("seals what it remembered for a person under their keys, and erases it with them: a retry runs nothing", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const { app, clock } = await createTestApp({ registry, adapter });
    await app.commands.registerCustomer(ana);
    const confirm = (customerId = "c-1") =>
      app.commands
        .confirmCustomer({ customerId }, { idempotencyKey: "confirm-1" })
        .catch((error: unknown) => error);
    const first = await confirm();
    expect(first).toMatchObject({
      rejected: "NotYet",
      message: "ana@example.com cannot be confirmed yet",
    });
    const key = await storage.personalKeys.get("c-1", "default");
    // Filed under a hash of the key, which is sealed with the answer.
    expect(await storage.idempotencyStore.get({ key: "confirm-1", now: clock.now() })).toBeNull();
    const [remembered] = await storage.idempotencyStore.listByPerson({
      person: "c-1",
      now: clock.now(),
    });
    expect(remembered).toMatchObject({
      answer: { $personal: { person: "c-1", key: key?.fingerprint } },
      persons: [{ person: "c-1", fingerprint: key?.fingerprint }],
    });
    expect(JSON.stringify(remembered)).not.toContain("ana@example.com");
    expect(JSON.stringify(remembered)).not.toContain("confirm-1");
    expect(await confirm()).toMatchObject({ message: "ana@example.com cannot be confirmed yet" });

    await app.forget("c-1");
    // A copy kept elsewhere names a key nobody holds any more.
    expect(await storage.personalKeys.list("c-1")).toEqual([]);
    expect(
      await storage.idempotencyStore.get({ key: remembered?.key ?? "", now: clock.now() }),
    ).toEqual({
      key: remembered?.key,
      answer: null,
      expiresAt: remembered?.expiresAt,
      persons: [],
    });
    for (const again of [await confirm(), await confirm("c-2")]) {
      expect(again).toBeInstanceOf(IdempotentAnswerErasedError);
      expect(again).toMatchObject({
        code: "IDEMPOTENT_ANSWER_ERASED",
        idempotencyKey: "confirm-1",
      });
    }
    clock.advance(24 * 60 * 60 * 1_000);
    expect(await confirm()).toMatchObject({
      rejected: "NotYet",
      message: "This customer cannot be confirmed yet",
    });
    await app.stop();
  });

  it("files an answer kept in the clear under its key's HMAC, erased, before a retry of it runs anything", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const { app, clock } = await createTestApp({ registry, adapter });
    await app.commands.registerCustomer(ana);
    const payload = { customerId: "c-1" };
    const outcome = {
      rejected: "NotYet",
      message: "kept before",
      aggregateType: "customer",
      aggregateId: "c-1",
    };
    await storage.idempotencyStore.put({
      key: "earlier-1",
      answer: { fingerprint: await fingerprintOf({ type: "ConfirmCustomer", payload }), outcome },
      expiresAt: "2026-01-02T00:00:00.000Z",
      persons: [],
      now: clock.now(),
    });
    const before = await storage.eventStore.lastPosition();
    const replayed = await app.commands
      .confirmCustomer(payload, { idempotencyKey: "earlier-1" })
      .catch((error: unknown) => error);
    expect(replayed).toBeInstanceOf(IdempotentAnswerErasedError);
    expect(await storage.eventStore.lastPosition()).toBe(before);
    expect(await storage.idempotencyStore.get({ key: "earlier-1", now: clock.now() })).toBeNull();
    const [filed] = await storage.idempotencyStore.list({ now: clock.now() });
    expect(filed).toMatchObject({ answer: null, expiresAt: "2026-01-02T00:00:00.000Z" });
    expect(JSON.stringify(await storage.idempotencyStore.list({ now: clock.now() }))).not.toContain(
      "earlier-1",
    );
    await app.stop();
  });

  it("hands out what it remembers for a person in their export, and replays it only on a basis while they are restricted", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const accesses: PersonalDataAccess[] = [];
    const { app } = await createTestApp({
      registry,
      adapter,
      onPersonalDataAccess: ({ access }) => {
        accesses.push(access);
      },
    });
    const registered = await app.commands.registerCustomer(ana, { idempotencyKey: "register-1" });
    const confirm = (options: { readonly processRestricted?: "consent" } = {}) =>
      app.commands
        .confirmCustomer({ customerId: "c-1" }, { idempotencyKey: "confirm-1", ...options })
        .catch((error: unknown) => error);
    const rejected = {
      rejected: "NotYet",
      message: "ana@example.com cannot be confirmed yet",
      aggregateType: "customer",
      aggregateId: "c-1",
    };
    await confirm();
    // A replay of nobody restricted records no access, on a basis or without one.
    await confirm();
    await confirm({ processRestricted: "consent" });
    expect(accesses.filter(({ operation }) => operation === "command")).toEqual([]);
    const remembered = await storage.idempotencyStore.listByPerson({
      person: "c-1",
      now: new Date(0),
    });
    expect(remembered).toHaveLength(2);
    expect(JSON.stringify(remembered)).not.toContain(registered.eventIds[0]);
    expect(JSON.stringify(remembered)).not.toContain("register-1");
    // In the order the store files them, by the HMAC of their keys.
    const answers = (await app.exportPersonalData("c-1")).answers;
    expect(answers).toHaveLength(2);
    expect(answers).toEqual(
      expect.arrayContaining([
        {
          idempotencyKey: "confirm-1",
          expiresAt: expect.any(String),
          outcome: rejected,
          restricted: [],
          withheld: [],
        },
        {
          idempotencyKey: "register-1",
          expiresAt: expect.any(String),
          outcome: registered,
          restricted: [],
          withheld: [],
        },
      ]),
    );
    expect((await app.exportPersonalData("c-2")).answers).toEqual([]);

    await app.restrict("c-1", { ground: "accuracy-contested" });
    expect(
      (await app.exportPersonalData("c-1")).answers.map(({ restricted }) => restricted),
    ).toEqual([["outcome"], ["outcome"]]);
    accesses.length = 0;
    expect(await confirm()).toBeInstanceOf(ProcessingRestrictedError);
    expect(accesses).toEqual([]);
    expect(await confirm({ processRestricted: "consent" })).toMatchObject({
      rejected: "NotYet",
      message: rejected.message,
    });
    expect(accesses).toMatchObject([
      {
        operation: "command",
        detail: { handler: "ConfirmCustomer" },
        outcome: "ok",
        persons: ["c-1"],
        restricted: { basis: "consent", persons: ["c-1"] },
      },
    ]);

    await app.forget("c-1");
    expect((await app.exportPersonalData("c-1")).answers).toEqual([]);
    await app.stop();
  });

  it("decides a command again when its person is forgotten between its load and its append", async () => {
    const adapter = memory();
    const storage = await adapter.createStorage();
    const { app } = await createTestApp({ registry, adapter });
    await app.commands.registerCustomer(ana);
    whileDeciding = () => app.forget("c-1");
    const reminded = await app.commands.remindCustomer({ customerId: "c-1" });
    expect(whileDeciding).toBeNull();
    expect(reminded.eventTypes).toEqual(["CustomerReminded"]);
    const [reminder] = await app.events.read({ after: reminded.position - 1 });
    expect(reminder?.payload).toEqual({});
    expect(await storage.personalKeys.get("c-1", "default")).toBeNull();
    expect(JSON.stringify(await app.events.read())).not.toContain("ana@example.com");
    await app.stop();
  });

  it.each([
    ["its stream", {}],
    ["a snapshot", snapshotted],
  ])(
    "decides a command again when its person is forgotten and keyed anew between its load from %s and its append",
    async (_, setup) => {
      const adapter = memory();
      const storage = await adapter.createStorage();
      const { app } = await createTestApp({ registry, ...setup, adapter });
      await app.commands.registerCustomer(ana);
      await app.runUntilIdle();
      const before = await storage.personalKeys.get("c-1", "default");
      whileDeciding = async () => {
        await app.forget("c-1");
        await app.commands.subscribe({
          newsletterId: "n-1",
          customerId: "c-1",
          email: "ana@again.example",
        });
      };
      const reminded = await app.commands.remindCustomer({ customerId: "c-1" });
      expect(whileDeciding).toBeNull();
      const [reminder] = await app.events.read({ after: reminded.position - 1 });
      expect(reminder?.type).toBe("CustomerReminded");
      expect(reminder?.payload).toEqual({});
      const after = await storage.personalKeys.get("c-1", "default");
      expect(after).not.toBeNull();
      expect(after?.fingerprint).not.toBe(before?.fingerprint);
      await app.stop();
    },
  );

  it("seals what a unit of work staged for a new person, with what it decided on it", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.invite({ newsletterId: "n-1", customerId: "c-3", email: "cy@example.com" });
    expect((await app.runUntilIdle()).idle).toBe(true);
    const events = await app.events.read();
    expect(events.map((event) => event.type)).toEqual([
      "Invited",
      "CustomerRegistered",
      "CustomerReminded",
    ]);
    expect(isSealed((events[2]?.payload as { to?: unknown } | undefined)?.to)).toBe(true);
    expect(await app.deadLetters.list()).toEqual([]);
    await app.stop();
  });

  it("exports a person's marked fields, before and after forgetting them", async () => {
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.commands.registerCustomer({ customerId: "c-2", email: "bo@example.com", name: "Bo" });
    await app.commands.subscribe({ newsletterId: "n-1", customerId: "c-1", email: ana.email });
    const before = await app.exportPersonalData("c-1");
    expect(before).toMatchObject({ personId: "c-1", exportedAt: "2026-01-01T00:00:00.000Z" });
    expect(before.events).toEqual([
      expect.objectContaining({
        type: "CustomerRegistered",
        aggregateType: "customer",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        data: { email: "ana@example.com" },
      }),
      expect.objectContaining({
        type: "Subscribed",
        aggregateType: "newsletter",
        aggregateId: "n-1",
        position: 3,
        data: { email: "ana@example.com" },
      }),
    ]);
    expect(before.scheduledCommands).toEqual([]);
    expect(before.deadLetters).toEqual([]);

    await app.forget("c-1");
    const after = await app.exportPersonalData("c-1");
    expect(after.events.map((event) => [event.type, event.data])).toEqual([
      ["CustomerRegistered", { email: null }],
      ["Subscribed", { email: null }],
      ["PersonalDataForgotten", {}],
    ]);
    expect(JSON.stringify(after)).not.toContain("ana@example.com");
    expect((await app.exportPersonalData("c-2")).events.map((event) => event.data)).toEqual([
      { email: "bo@example.com" },
    ]);
    await expect(app.exportPersonalData("")).rejects.toBeInstanceOf(ValidationError);
    await app.stop();
  });

  it("refuses the commands that touch a restricted person, dead-letters the reactions that do, and retries them once the restriction is lifted", async () => {
    restricted.length = 0;
    const bo = { customerId: "c-2", email: "bo@example.com", name: "Bo" };
    const { app } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.commands.registerCustomer(bo);
    expect(await app.restrict("c-2", { ground: "accuracy-contested" })).toMatchObject({
      aggregateType: "bounda",
      aggregateId: "c-2",
      eventTypes: ["ProcessingRestricted"],
      position: 3,
    });
    expect((await app.restrict("c-2", { ground: "accuracy-contested" })).eventIds).toEqual([]);

    // The aggregate is the person, the payload names the person, and a command with `delay` is
    // refused before it is scheduled.
    const refused = await app.commands
      .greetCustomer({ customerId: "c-2" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProcessingRestrictedError);
    expect(refused).toMatchObject({ code: "PROCESSING_RESTRICTED", personId: "c-2" });
    await expect(
      app.commands.subscribe({ newsletterId: "n-1", customerId: "c-2", email: "bo@example.com" }),
    ).rejects.toMatchObject({ code: "PROCESSING_RESTRICTED", personId: "c-2" });
    await expect(
      app.commands.remindCustomer({ customerId: "c-2" }, { delay: "1m" }),
    ).rejects.toMatchObject({ code: "PROCESSING_RESTRICTED" });
    expect((await app.commands.greetCustomer({ customerId: "c-1" })).eventTypes).toEqual([
      "CustomerGreeted",
    ]);

    // A policy on an event that names nobody, dispatching for the person: its letter names them.
    await app.commands.invite({ newsletterId: "n-1", customerId: "c-2", email: "bo@example.com" });
    expect((await app.runUntilIdle()).idle).toBe(true);
    expect(restricted).toEqual(["c-2"]);
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      kind: "policy",
      handler: "customer.registerOnInvited",
      aggregateType: "newsletter",
      person: "c-2",
      status: "failed",
      errorType: "terminal",
      errorName: "ProcessingRestrictedError",
      errorCode: "PROCESSING_RESTRICTED",
      errorMessage: null,
      restricted: true,
    });
    expect(
      (await app.deadLetters.list(undefined, { includeRestricted: "legal-claims" }))[0],
    ).toMatchObject({
      errorMessage: "The processing of this person's data is restricted",
    });
    expect(
      (await app.deadLetters.list(undefined, { includeRestricted: "consent" }))[0],
    ).not.toHaveProperty("restricted");
    expect(await app.deadLetters.list()).toHaveLength(1);

    // Forgetting stays allowed.
    await app.restrict("c-3", { ground: "accuracy-contested" });
    expect((await app.forget("c-3")).eventTypes).toEqual(["PersonalDataForgotten"]);

    expect(await app.unrestrict("c-2", { notice: "given" })).toMatchObject({
      eventTypes: ["ProcessingRestrictionLifted"],
    });
    expect((await app.unrestrict("c-2", { notice: "given" })).eventIds).toEqual([]);
    expect((await app.runUntilIdle()).idle).toBe(true);
    expect((await app.deadLetters.list()).map(({ id, status }) => [id, status])).toEqual([
      [letter?.id, "retried"],
    ]);
    expect((await app.events.read()).map((event) => [event.aggregateId, event.type])).toEqual([
      ["c-1", "CustomerRegistered"],
      ["c-2", "CustomerRegistered"],
      ["c-2", "ProcessingRestricted"],
      ["c-1", "CustomerGreeted"],
      ["n-1", "Invited"],
      ["c-3", "ProcessingRestricted"],
      ["c-3", "PersonalDataForgotten"],
      ["c-2", "ProcessingRestrictionLifted"],
      ["c-2", "CustomerRegistered"],
      ["c-2", "CustomerReminded"],
    ]);
    expect((await app.commands.greetCustomer({ customerId: "c-2" })).eventTypes).toEqual([
      "CustomerGreeted",
    ]);
    await app.stop();
  });

  it.each([
    ["without", {}],
    ["with", { idempotencyKey: "remind-1" }],
  ])(
    "refuses a command %s an idempotency key that was running when restrict committed, storing none of its events",
    async (_, options) => {
      const adapter = memory();
      const storage = await adapter.createStorage();
      const { app, clock } = await createTestApp({ registry, adapter });
      await app.commands.registerCustomer(ana);
      whileDeciding = () => app.restrict("c-1", { ground: "accuracy-contested" });
      const refused = await app.commands
        .remindCustomer({ customerId: "c-1" }, options)
        .catch((error: unknown) => error);
      expect(whileDeciding).toBeNull();
      expect(refused).toBeInstanceOf(ProcessingRestrictedError);
      expect(refused).toMatchObject({ personId: "c-1" });
      expect((await app.events.read()).map((event) => event.type)).toEqual([
        "CustomerRegistered",
        "ProcessingRestricted",
      ]);
      expect(await storage.idempotencyStore.get({ key: "remind-1", now: clock.now() })).toBeNull();
      await app.stop();
    },
  );

  it("dead-letters a reaction whose command was running when restrict committed, and retries it once lifted", async () => {
    const { app } = await createTestApp({ registry });
    whileDeciding = () => app.restrict("c-3", { ground: "accuracy-contested" });
    await app.commands.invite({ newsletterId: "n-1", customerId: "c-3", email: "cy@example.com" });
    expect((await app.runUntilIdle()).idle).toBe(true);
    expect(whileDeciding).toBeNull();
    expect(await app.deadLetters.list()).toMatchObject([
      {
        kind: "policy",
        handler: "customer.registerOnInvited",
        person: "c-3",
        errorType: "terminal",
        errorCode: "PROCESSING_RESTRICTED",
      },
    ]);
    expect((await app.events.read()).map((event) => event.type)).toEqual([
      "Invited",
      "ProcessingRestricted",
    ]);
    await app.unrestrict("c-3", { notice: "given" });
    expect((await app.runUntilIdle()).idle).toBe(true);
    expect((await app.events.read()).map((event) => event.type)).toEqual([
      "Invited",
      "ProcessingRestricted",
      "ProcessingRestrictionLifted",
      "CustomerRegistered",
      "CustomerReminded",
    ]);
    await app.stop();
  });

  it("dead-letters a scheduled command that comes due under a restriction, naming the person the refusal names", async () => {
    const { app, clock } = await createTestApp({ registry });
    await app.commands.registerCustomer(ana);
    await app.commands.remindCustomer({ customerId: "c-1" }, { delay: "1m" });
    await app.restrict("c-1", { ground: "accuracy-contested" });
    clock.advance(60_000);
    expect((await app.runUntilIdle()).idle).toBe(true);
    const [letter] = await app.deadLetters.list();
    expect(letter).toMatchObject({
      kind: "scheduled",
      handler: "RemindCustomer",
      person: "c-1",
      errorType: "terminal",
      errorCode: "PROCESSING_RESTRICTED",
      payload: { customerId: "c-1" },
    });
    expect(letter).not.toHaveProperty("persons");
    await app.unrestrict("c-1", { notice: "given" });
    expect((await app.runUntilIdle()).idle).toBe(true);
    expect((await app.deadLetters.list())[0]?.status).toBe("retried");
    expect((await app.events.read()).map((event) => event.type)).toEqual([
      "CustomerRegistered",
      "ProcessingRestricted",
      "ScheduledCommandFailed",
      "ProcessingRestrictionLifted",
      "CustomerReminded",
    ]);
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
