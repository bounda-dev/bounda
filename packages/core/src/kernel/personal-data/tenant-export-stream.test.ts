import { describe, expect, it } from "vitest";
import type { ForgetLedger, ForgetLedgerEntry } from "../../adapter/storage/forget-ledger.ts";
import type { Table as RowTable } from "../../adapter/storage/table.ts";
import { pendingEvent, testContext, testDeadLetter } from "../../adapter/testing/fixtures.ts";
import { resolveConfig } from "../../config/schema.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { ConcurrencyError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type ExportOutcome, MAX_ACCESS_PERSONS } from "../../modules/audit.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { type AppStorage, appStorage } from "../events/app-event-store.ts";
import { buildReadModels } from "../read-model/build-read-models.ts";
import { sealedTable } from "../read-model/sealed-table.ts";
import { createSealingKeyRing } from "../read-model/sealing-keys.ts";
import type { RecipientsRuntime } from "../recipients/build.ts";
import { keysOver, testWrapping } from "../test-support.ts";
import { sealAnswer } from "./answers.ts";
import { createAtRestSealer } from "./at-rest.ts";
import { buildPersonalCategories } from "./categories.ts";
import { sealCommandPayload } from "./commands.ts";
import { sealError } from "./errors.ts";
import type { TenantExportCounts, TenantExportPart, TenantExportRecord } from "./tenant-export.ts";
import {
  recordedTenantExport,
  type StreamedTenantExport,
  streamTenantExport,
  TenantDataChangedError,
} from "./tenant-export-stream.ts";

const NO_RECIPIENTS: RecipientsRuntime = { all: [], byPort: {}, byOwner: {} };

type Table = RowTable<Record<string, unknown>>;

const DAY = 86_400_000;
const invoices = { category: "invoices" as never };

const registry: Registry = {
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ email: personal(z.email()), plan: z.string() }),
          evolve: () => ({}),
        },
      },
      commands: {
        remindCustomer: {
          module: {
            payload: ({ z, personal }: CommandPayloadArgs) =>
              z.object({ customerId: z.string(), email: personal(z.email()) }),
            handler: () => [],
          },
        },
      },
      policies: {},
      processes: {},
    },
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, personal, person }: EventPayloadArgs) =>
            z.object({
              customerId: person(z.string()),
              note: personal(z.string(), invoices).optional(),
              total: z.number(),
            }),
          evolve: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {
    orderNotes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          customerId: f.string().person(),
          note: f.string().personal(invoices).optional(),
          total: f.number(),
        }),
      },
      projections: {},
      queries: {},
    },
    // No field marked: its rows name nobody.
    orderTotals: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          total: f.number(),
        }),
      },
      projections: {},
      queries: {},
    },
  },
  personalData: {
    automatedDecisions: {},
    categories: {
      invoices: {
        basis: "legal-obligation",
        retention: "60d",
        purposes: ["Serve the person"],
        sources: ["data-subject"],
      },
    },
  },
};

const categories = buildPersonalCategories({
  module: registry.personalData,
  retention: { months: 0, ms: 30 * DAY },
});

const entry = (personId: string, at: number): ForgetLedgerEntry => ({
  personId,
  categories: null,
  eventId: `e-${personId}`,
  forgottenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, at)).toISOString(),
  reason: "requested",
});

// A ledger that pages its entries as a store does.
const ledgerOf = (entries: readonly ForgetLedgerEntry[]): ForgetLedger => ({
  append: async () => undefined,
  read: async ({ after, limit }) =>
    entries
      .filter(
        (entry) =>
          after === undefined ||
          entry.forgottenAt > after.forgottenAt ||
          (entry.forgottenAt === after.forgottenAt && entry.eventId > after.eventId),
      )
      .slice(0, limit),
  readMark: async () => 0,
  raiseMark: async () => undefined,
});

const setup = async () => {
  const aggregates = buildAggregates({ registry, ports: {} });
  const readModels = await buildReadModels({
    registry,
    config: resolveConfig({ storage: memory(), readModels: { orderNotes: memory() } }),
    logger: silentLogger,
  });
  const written = await memory().createStorage();
  const storage: AppStorage = appStorage({
    storage: written,
    aggregates,
    processes: { byName: {} },
    wrapping: testWrapping(),
    atRest: {
      ...createAtRestSealer(
        await crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]),
      ),
      lookups: async (key) => [key],
    },
  });
  const table = (name: string): Table => {
    const readModel = readModels.byName[name];
    if (readModel === undefined) throw new Error(`no read model ${name}`);
    return sealedTable({
      context: {
        layout: readModel.layout,
        keys: createSealingKeyRing({ keys: storage.personalKeys, fetching: true }),
        indexer: null,
        event: () => null,
      },
      table: readModel.storage.table,
    }) as Table;
  };
  const pages: string[] = [];
  const stream = ({
    batchSize = 2,
    ledger = null,
    onPage = async () => {
      pages.push("page");
    },
  }: {
    readonly batchSize?: number;
    readonly ledger?: ForgetLedger | null;
    readonly onPage?: () => Promise<void>;
  } = {}) =>
    streamTenantExport({
      storage,
      aggregates,
      processes: { byName: {} },
      readModels,
      sealing: { keys: storage.personalKeys, indexer: null, redactions: async () => [] },
      clock: createFixedClock(),
      batchSize,
      categories,
      recipients: NO_RECIPIENTS,
      ports: new Map([["invoices", ["order.billing", "order.ledger"]]]),
      tenant: "acme",
      exportId: "x-1",
      ledger,
      onPage,
    });
  const exported = async (args?: Parameters<typeof stream>[0]): Promise<TenantExportPart[]> => {
    const { header, parts } = await stream(args);
    const all: TenantExportPart[] = [{ kind: "header", header }];
    for await (const part of parts) all.push(part);
    return all;
  };
  const append = (aggregateType: string, aggregateId: string, type: string, payload: object) =>
    storage.eventStore.append({
      aggregateType,
      aggregateId,
      expectedVersion: 0,
      events: [pendingEvent({ aggregateType, aggregateId, version: 1, type, payload })],
    });
  const register = (aggregateId: string, email: string) =>
    append("customer", aggregateId, "CustomerRegistered", { email, plan: "pro" });
  const place = (aggregateId: string, payload: object) =>
    append("order", aggregateId, "OrderPlaced", payload);
  const reminder = (customerId: string, email: string) =>
    sealCommandPayload({
      type: "RemindCustomer",
      aggregateId: customerId,
      payload: { customerId, email },
      marks: aggregates.commandsByType.RemindCustomer?.command.personal ?? null,
      keys: keysOver(storage.personalKeys),
    });
  // A person's key of the default category, made when they hold none.
  const keyed = async (person: string) => {
    await storage.personalKeys.create(person, "default");
    const held = (await storage.personalKeys.list(person)).find(
      ({ category }) => category === "default",
    );
    return { person, fingerprint: held?.key.fingerprint ?? "" };
  };
  const failure = async (person: string | null, message: string, read?: readonly string[]) => {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at handler`;
    return sealError({
      error,
      person,
      ...(read === undefined ? {} : { read: await Promise.all(read.map(keyed)) }),
      keys: keysOver(storage.personalKeys),
    });
  };
  const restrict = (person: string, categories: readonly string[] | null) =>
    storage.persons.restrict(person, {
      ground: "accuracy-contested",
      categories,
      since: new Date("2026-01-01T00:00:00.000Z"),
    });
  return {
    storage,
    stream,
    exported,
    register,
    place,
    reminder,
    failure,
    restrict,
    keyed,
    table,
    pages,
  };
};

const of = <Kind extends TenantExportPart["kind"]>(
  parts: readonly TenantExportPart[],
  kind: Kind,
): Extract<TenantExportPart, { readonly kind: Kind }>[] =>
  parts.filter(
    (part): part is Extract<TenantExportPart, { readonly kind: Kind }> => part.kind === kind,
  );

describe("streamTenantExport", () => {
  it("hands out every event up to the head, its whole payload opened and its marked fields named", async () => {
    const { exported, register, place, restrict, storage } = await setup();
    await register("c-1", "ana@example.com");
    await place("o-1", { customerId: "c-1", note: "ring twice", total: 10 });
    await register("c-2", "bo@example.com");
    await place("o-2", { customerId: "c-2", total: 20 });
    await storage.eventStore.append({
      aggregateType: "order",
      aggregateId: "o-3",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "order",
          aggregateId: "o-3",
          version: 1,
          type: "OrderShipped",
          payload: { carrier: "post" },
        }),
      ],
    });
    await restrict("c-2", ["invoices"]);
    const parts = await exported();
    expect(parts[0]).toEqual({
      kind: "header",
      header: {
        format: "bounda.tenant-export",
        version: 1,
        tenant: "acme",
        exportId: "x-1",
        exportedAt: "2026-01-01T00:00:00.000Z",
        position: 5,
        categories: {
          default: {
            basis: null,
            special: null,
            criminal: null,
            purposes: [],
            processedFor: [],
            erasureExemptions: [],
            sources: [],
            retention: "30d",
            ports: [],
          },
          invoices: {
            basis: "legal-obligation",
            special: null,
            criminal: null,
            purposes: ["Serve the person"],
            processedFor: [],
            erasureExemptions: [{ exemption: "legal-obligation", article: "17(3)(b)" }],
            sources: ["data-subject"],
            retention: "60d",
            ports: ["order.billing", "order.ledger"],
          },
        },
        readModels: ["orderNotes", "orderTotals"],
      },
    });
    expect(of(parts, "event").map(({ event }) => event)).toStrictEqual([
      {
        id: "customer-c-1-1",
        type: "CustomerRegistered",
        aggregateType: "customer",
        aggregateId: "c-1",
        version: 1,
        position: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: expect.any(Object),
        person: "c-1",
        payload: { email: "ana@example.com", plan: "pro" },
        categories: { email: "default" },
        restricted: [],
        redacted: [],
      },
      expect.objectContaining({
        position: 2,
        person: "c-1",
        payload: { customerId: "c-1", note: "ring twice", total: 10 },
        categories: { note: "invoices" },
        restricted: [],
      }),
      expect.objectContaining({
        position: 3,
        payload: { email: "bo@example.com", plan: "pro" },
        categories: { email: "default" },
        restricted: [],
      }),
      // No note: no field of the restricted category to mark.
      expect.objectContaining({
        position: 4,
        payload: { customerId: "c-2", total: 20 },
        categories: {},
        restricted: [],
      }),
      // A type the aggregate does not define marks nothing, and names nobody.
      expect.objectContaining({
        position: 5,
        person: null,
        payload: { carrier: "post" },
        categories: {},
        restricted: [],
      }),
    ]);
    // Written while they were not restricted.
    await storage.persons.unrestrict("c-2", { categories: null });
    await place("o-4", { customerId: "c-2", note: "leave it", total: 5 });
    await restrict("c-2", ["invoices"]);
    await restrict("c-1", null);
    const again = of(await exported(), "event").map(({ event }) => event);
    expect(again.map(({ position, restricted }) => [position, restricted])).toEqual([
      [1, ["email"]],
      [2, ["note"]],
      [3, []],
      [4, []],
      [5, []],
      [6, ["note"]],
    ]);
  });

  it("marks restricted the fields a forgetting kept, opened under a key it kept, and no field after", async () => {
    const { exported, register, place, storage } = await setup();
    await register("c-1", "ana@example.com");
    await place("o-1", { customerId: "c-1", note: "ring twice", total: 10 });
    const invoiceKey = (await storage.personalKeys.list("c-1")).find(
      ({ category }) => category === "invoices",
    );
    await storage.personalKeys.retain("c-1", invoiceKey?.key.fingerprint ?? "", {
      since: "2026-01-10T00:00:00.000Z",
      lastActiveAt: "2026-01-05T00:00:00.000Z",
    });
    await place("o-2", { customerId: "c-1", note: "back again", total: 20 });
    const parts = await exported();
    expect(of(parts, "event").map(({ event }) => [event.position, event.restricted])).toEqual([
      [1, []],
      [2, ["note"]],
      [3, []],
    ]);
    expect(of(parts, "person").map(({ person }) => person)).toEqual([
      {
        personId: "c-1",
        lastActiveAt: null,
        forgottenAt: null,
        categories: {
          default: { keptUntil: null, restrictedUntil: null },
          invoices: { keptUntil: null, restrictedUntil: "2026-03-06T00:00:00.000Z" },
        },
        restrictions: [],
        recipients: [],
      },
    ]);
  });

  it("hands out every person once, from their keys and their records, in order, a page at a time", async () => {
    const { exported, register, restrict, storage } = await setup();
    for (const person of ["c-3", "c-1", "c-5"]) await register(person, `${person}@example.com`);
    // Restricted without any data: a record and no key.
    await restrict("c-2", null);
    await restrict("c-4", ["invoices"]);
    // Recorded as active, and holding a key too.
    await storage.persons.record({
      person: "c-3",
      position: 1,
      lastActiveAt: "2026-01-02T00:00:00.000Z",
      forgottenAt: null,
    });
    const persons = of(await exported({ batchSize: 2 }), "person").map(({ person }) => person);
    expect(persons.map(({ personId }) => personId)).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"]);
    expect(persons[1]).toEqual({
      personId: "c-2",
      lastActiveAt: null,
      forgottenAt: null,
      categories: {},
      restrictions: [{ ground: "accuracy-contested", categories: null, since: expect.any(String) }],
      recipients: [],
    });
    expect(persons[2]).toMatchObject({
      lastActiveAt: "2026-01-02T00:00:00.000Z",
      categories: { default: { keptUntil: "2026-02-01T00:00:00.000Z", restrictedUntil: null } },
    });
    expect(persons[3]?.restrictions).toEqual([
      { ground: "accuracy-contested", categories: ["invoices"], since: expect.any(String) },
    ]);
    // A page of either store that runs out before the other.
    for (const batchSize of [1, 3, 5, 6]) {
      expect(
        of(await exported({ batchSize }), "person").map(({ person }) => person.personId),
      ).toEqual(["c-1", "c-2", "c-3", "c-4", "c-5"]);
    }
  });

  it("hands out every scheduled command and dead letter, payload and error text opened, whoever they name", async () => {
    const { exported, storage, reminder, failure, restrict } = await setup();
    const ana = await reminder("c-1", "ana@example.com");
    const bo = await reminder("c-2", "bo@example.com");
    for (const [key, sealed, executeAt] of [
      ["command:b", bo, "2026-01-02T00:00:00.000Z"],
      ["command:a", ana, "2026-01-03T00:00:00.000Z"],
      ["command:c", ana, "2026-01-01T00:00:00.000Z"],
    ] as const) {
      await storage.scheduler.schedule({
        dedupeKey: key,
        command: { type: "RemindCustomer", aggregateId: "c", payload: sealed.payload },
        executeAt: new Date(executeAt),
        scheduledAt: new Date("2026-01-01T00:00:00.000Z"),
        context: testContext,
        persons: sealed.persons,
      });
    }
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-2"),
      ...(await failure("c-1", "no mailbox for ana@example.com", ["c-2"])),
      kind: "scheduled",
      handler: "RemindCustomer",
      eventType: "RemindCustomer",
      person: "c-1",
      readPersons: ["c-2"],
      payload: ana.payload,
      persons: ana.persons,
    });
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-1"),
      ...(await failure("c-2", "bo@example.com bounced")),
      errorStack: undefined,
      person: "c-2",
    } as never);
    await storage.deadLetterStore.add({
      ...testDeadLetter("dl-3"),
      errorMessage: "in the clear",
      person: null,
    });
    const parts = await exported();
    expect(of(parts, "scheduledCommand").map(({ scheduledCommand }) => scheduledCommand)).toEqual([
      {
        dedupeKey: "command:a",
        type: "RemindCustomer",
        aggregateId: "c",
        payload: { customerId: "c-1", email: "ana@example.com" },
        executeAt: "2026-01-03T00:00:00.000Z",
        scheduledAt: "2026-01-01T00:00:00.000Z",
        context: testContext,
        attempts: 0,
        persons: ["c-1"],
        categories: { email: "default" },
        restricted: [],
      },
      expect.objectContaining({
        dedupeKey: "command:b",
        payload: { customerId: "c-2", email: "bo@example.com" },
        persons: ["c-2"],
      }),
      expect.objectContaining({ dedupeKey: "command:c" }),
    ]);
    const letters = of(parts, "deadLetter").map(({ deadLetter }) => deadLetter);
    expect(letters.map(({ id }) => id)).toEqual(["dl-1", "dl-2", "dl-3"]);
    expect(letters[0]).toEqual({
      ...testDeadLetter("dl-1"),
      status: "failed",
      person: "c-2",
      errorName: "Error",
      errorMessage: "bo@example.com bounced",
      persons: [],
      categories: {},
      restricted: [],
    });
    expect(letters[1]).toEqual(
      expect.objectContaining({
        kind: "scheduled",
        readPersons: ["c-2"],
        errorMessage: "no mailbox for ana@example.com",
        errorStack: "Error: no mailbox for ana@example.com\n    at handler",
        payload: { customerId: "c-1", email: "ana@example.com" },
        persons: ["c-1"],
        categories: { email: "default" },
        restricted: [],
      }),
    );
    expect(letters[1]).not.toHaveProperty("$personal");
    expect(letters[2]).toMatchObject({ errorMessage: "in the clear", restricted: [] });
    expect(letters[2]).not.toHaveProperty("payload");

    // Bo is restricted: what is sealed under him, or names him, is marked.
    await restrict("c-2", null);
    const restricted = await exported();
    expect(
      of(restricted, "scheduledCommand").map(({ scheduledCommand }) => [
        scheduledCommand.dedupeKey,
        scheduledCommand.restricted,
      ]),
    ).toEqual([
      ["command:a", []],
      ["command:b", ["email"]],
      ["command:c", []],
    ]);
    expect(
      of(restricted, "deadLetter").map(({ deadLetter }) => [deadLetter.id, deadLetter.restricted]),
    ).toEqual([
      ["dl-1", ["errorMessage"]],
      ["dl-2", ["errorMessage", "errorStack"]],
      ["dl-3", []],
    ]);
    // A restriction of a category marks what holds its fields, and no text.
    await storage.persons.unrestrict("c-2", { categories: null });
    await restrict("c-1", ["default"]);
    const byCategory = await exported();
    expect(
      of(byCategory, "deadLetter").map(({ deadLetter }) => [deadLetter.id, deadLetter.restricted]),
    ).toEqual([
      ["dl-1", []],
      ["dl-2", ["email", "errorMessage", "errorStack"]],
      ["dl-3", []],
    ]);
  });

  it("hands out every subscriber's last failure, its text opened, marked while one it is sealed under is restricted", async () => {
    const { exported, storage, failure, restrict, keyed } = await setup();
    await keyed("c-1");
    const sealed = await failure("c-1", "cannot index ana@example.com", ["c-2"]);
    await storage.subscriberFailures.record({
      subscriber: "projection:a",
      position: 1,
      eventId: "e-1",
      eventType: "CustomerRegistered",
      person: "c-1",
      readPersons: ["c-2"],
      errorName: "Error",
      errorMessage: sealed.errorMessage,
      errorStack: sealed.errorStack,
      failedAt: "2026-01-01T00:00:00.000Z",
    } as never);
    await storage.subscriberFailures.record({
      subscriber: "projection:b",
      position: 2,
      eventId: "e-2",
      eventType: "OrderShipped",
      person: null,
      errorName: "Error",
      errorMessage: "no stack",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const failures = (parts: readonly TenantExportPart[]) =>
      of(parts, "subscriberFailure").map(({ subscriberFailure }) => subscriberFailure);
    expect(failures(await exported())).toEqual([
      {
        subscriber: "projection:a",
        position: 1,
        eventId: "e-1",
        eventType: "CustomerRegistered",
        person: "c-1",
        readPersons: ["c-2"],
        errorName: "Error",
        errorMessage: "cannot index ana@example.com",
        errorStack: "Error: cannot index ana@example.com\n    at handler",
        attempts: 1,
        firstFailedAt: "2026-01-01T00:00:00.000Z",
        lastFailedAt: "2026-01-01T00:00:00.000Z",
        resolvedAt: null,
        restricted: [],
      },
      expect.objectContaining({ subscriber: "projection:b", errorMessage: "no stack" }),
    ]);
    await restrict("c-2", ["invoices"]);
    expect(failures(await exported()).map(({ restricted }) => restricted)).toEqual([
      ["errorMessage", "errorStack"],
      [],
    ]);
  });

  it("hands out every remembered answer that still opens, and what it names", async () => {
    const { exported, storage, restrict, keyed } = await setup();
    await keyed("c-1");
    const now = new Date("2026-01-01T00:00:00.000Z");
    const outcome = {
      rejected: "Taken",
      message: "ana@example.com is taken",
      aggregateType: "customer",
      aggregateId: "c-1",
    };
    for (const filed of ["h-2", "h-1", "h-3"]) {
      const sealed = await sealAnswer({
        keys: storage.personalKeys,
        atRest: storage.atRest,
        answer: { key: `confirm-${filed}`, fingerprint: "fp", outcome },
        person: "c-1",
        marks: null,
        payload: {},
        read: [],
      });
      await storage.idempotencyStore.put({
        key: filed,
        answer: filed === "h-3" ? null : sealed.answer,
        persons: filed === "h-3" ? [] : sealed.persons,
        expiresAt: "2026-01-02T00:00:00.000Z",
        now,
      });
    }
    const answers = (parts: readonly TenantExportPart[]) =>
      of(parts, "answer").map(({ answer }) => answer);
    expect(answers(await exported({ batchSize: 1 }))).toEqual([
      {
        idempotencyKey: "confirm-h-1",
        expiresAt: "2026-01-02T00:00:00.000Z",
        outcome,
        persons: ["c-1"],
        restricted: [],
      },
      expect.objectContaining({ idempotencyKey: "confirm-h-2" }),
    ]);
    await restrict("c-1", ["invoices"]);
    expect(answers(await exported()).map(({ restricted }) => restricted)).toEqual([
      ["outcome"],
      ["outcome"],
    ]);
    // Once the person is forgotten, nothing of it opens.
    for (const { key } of await storage.personalKeys.list("c-1")) {
      await storage.personalKeys.remove("c-1", key.fingerprint);
    }
    expect(answers(await exported())).toEqual([]);
  });

  it("hands out every row of every read model, every field of its view, a page at a time", async () => {
    const { exported, storage, table, restrict } = await setup();
    await storage.personalKeys.create("c-1", "invoices");
    const notes = table("orderNotes");
    for (const [orderId, customerId, note] of [
      ["o-3", "c-1", "ring twice"],
      ["o-1", "c-2", undefined],
      ["o-2", "c-1", "leave it"],
    ] as const) {
      await notes.upsert({
        orderId,
        customerId,
        ...(note === undefined ? {} : { note }),
        total: 1,
      });
    }
    await table("orderTotals").upsert({ orderId: "o-9", total: 9 });
    const rows = (parts: readonly TenantExportPart[]) =>
      of(parts, "row").map(({ readModel, row }) => [readModel, row]);
    expect(rows(await exported({ batchSize: 2 }))).toEqual([
      [
        "orderNotes",
        {
          key: "o-1",
          data: { orderId: "o-1", customerId: "c-2", note: null, total: 1 },
          person: "c-2",
          categories: {},
          restricted: [],
        },
      ],
      [
        "orderNotes",
        {
          key: "o-2",
          data: { orderId: "o-2", customerId: "c-1", note: "leave it", total: 1 },
          person: "c-1",
          categories: { note: "invoices" },
          restricted: [],
        },
      ],
      ["orderNotes", expect.objectContaining({ key: "o-3" })],
      [
        "orderTotals",
        {
          key: "o-9",
          data: { orderId: "o-9", total: 9 },
          person: null,
          categories: {},
          restricted: [],
        },
      ],
    ]);
    await restrict("c-1", ["invoices"]);
    expect(of(await exported(), "row").map(({ row }) => row.restricted)).toEqual([
      [],
      ["note"],
      ["note"],
      [],
    ]);
    // What a forgetting kept is opened, marked.
    await storage.persons.unrestrict("c-1", { categories: null });
    const [kept] = await storage.personalKeys.list("c-1");
    await storage.personalKeys.retain("c-1", kept?.key.fingerprint ?? "", {
      since: "2026-01-10T00:00:00.000Z",
      lastActiveAt: "2026-01-05T00:00:00.000Z",
    });
    expect(of(await exported(), "row").map(({ row }) => [row.data.note, row.restricted])).toEqual([
      [null, []],
      ["leave it", ["note"]],
      ["ring twice", ["note"]],
      [undefined, []],
    ]);
  });

  it("hands out every entry of the forget ledger, a page at a time, and none without a ledger", async () => {
    const { exported } = await setup();
    const entries = [entry("c-1", 1), entry("c-2", 2), entry("c-3", 2), entry("c-4", 3)];
    for (const batchSize of [1, 2, 4, 5]) {
      expect(
        of(await exported({ batchSize, ledger: ledgerOf(entries) }), "forgetLedgerEntry").map(
          (part) => part.entry,
        ),
      ).toEqual(entries);
    }
    expect(of(await exported(), "forgetLedgerEntry")).toEqual([]);
  });

  it("ends with how many parts of each kind it handed out", async () => {
    const { exported, register, table } = await setup();
    await register("c-1", "ana@example.com");
    await table("orderTotals").upsert({ orderId: "o-9", total: 9 });
    const parts = await exported({ ledger: ledgerOf([entry("c-9", 1)]) });
    expect(parts.map(({ kind }) => kind)).toEqual([
      "header",
      "person",
      "event",
      "row",
      "forgetLedgerEntry",
      "end",
    ]);
    expect(parts.at(-1)).toEqual({
      kind: "end",
      counts: {
        persons: 1,
        events: 1,
        scheduledCommands: 0,
        deadLetters: 0,
        subscriberFailures: 0,
        answers: 0,
        readModelRows: 1,
        forgetLedgerEntries: 1,
      },
    });
  });

  it("vouches for the header and each page that hands something out before it does", async () => {
    const { stream, register, pages } = await setup();
    for (const person of ["c-1", "c-2", "c-3"]) await register(person, `${person}@example.com`);
    const { parts } = await stream({ batchSize: 2 });
    expect(pages).toEqual(["page"]);
    const seen: string[] = [];
    for await (const part of parts) seen.push(`${part.kind}:${pages.length}`);
    // Persons in two pages, events in two, nothing else but the end.
    expect(seen).toEqual([
      "person:2",
      "person:2",
      "person:3",
      "event:4",
      "event:4",
      "event:5",
      "end:5",
    ]);
    const refused = new Error("restored");
    await expect(
      stream({
        onPage: async () => {
          throw refused;
        },
      }),
    ).rejects.toBe(refused);
  });

  it("hands out nothing past the head, and fails without its end once the stream moved past it", async () => {
    const { stream, register } = await setup();
    await register("c-1", "ana@example.com");
    await register("c-2", "bo@example.com");
    const { header, parts } = await stream({ batchSize: 1 });
    expect(header.position).toBe(2);
    await register("c-3", "cy@example.com");
    const seen: TenantExportPart[] = [];
    const reading = (async () => {
      for await (const part of parts) seen.push(part);
    })();
    const failure = await reading.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TenantDataChangedError);
    expect(failure).toBeInstanceOf(ConcurrencyError);
    expect(failure).toMatchObject({
      tenant: "acme",
      streamId: "$all",
      expectedVersion: 2,
      actualVersion: 3,
      message: "Tenant acme's data changed while it was exported",
      code: "CONCURRENCY_CONFLICT",
    });
    expect(of(seen, "event").map(({ event }) => event.position)).toEqual([1, 2]);
    expect(seen.some(({ kind }) => kind === "end")).toBe(false);
  });
});

describe("recordedTenantExport", () => {
  const counts = (records: number): TenantExportCounts => ({
    persons: records,
    events: 1,
    scheduledCommands: 0,
    deadLetters: 0,
    subscriberFailures: 0,
    answers: 0,
    readModelRows: 0,
    forgetLedgerEntries: 0,
  });

  const streamedOf = (
    records: readonly TenantExportRecord[],
    failure?: unknown,
  ): StreamedTenantExport => ({
    header: {
      format: "bounda.tenant-export",
      version: 1,
      tenant: "acme",
      exportId: "x-1",
      exportedAt: "2026-01-01T00:00:00.000Z",
      position: 1,
      categories: {},
      readModels: [],
    },
    parts: (async function* () {
      yield* records;
      if (failure !== undefined) throw failure;
      yield { kind: "end", counts: counts(records.length - 1) } as const;
    })(),
  });

  const personPart = (index: number): TenantExportRecord => ({
    kind: "person",
    person: {
      personId: `p-${String(index).padStart(3, "0")}`,
      lastActiveAt: null,
      forgottenAt: null,
      categories: {},
      restrictions: [],
      recipients: [],
    },
  });

  const eventPart: TenantExportRecord = {
    kind: "event",
    event: {
      id: "e-1",
      type: "T",
      aggregateType: "a",
      aggregateId: "1",
      version: 1,
      position: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: {} as never,
      person: null,
      payload: {},
      categories: {},
      restricted: [],
      redacted: [],
    },
  };

  const recorder = () => {
    const records: [ExportOutcome, unknown, TenantExportCounts, readonly string[]][] = [];
    const errors: unknown[] = [];
    return {
      records,
      errors,
      record: async (
        outcome: ExportOutcome,
        error: unknown,
        counted: TenantExportCounts,
        persons: readonly string[],
      ) => {
        records.push([outcome, error, counted, persons]);
      },
      onError: (error: unknown) => {
        errors.push(error);
      },
    };
  };

  it("records it started before the header, then ok with what it handed out, naming the first persons", async () => {
    const { records, record, onError } = recorder();
    const many = Array.from({ length: MAX_ACCESS_PERSONS + 1 }, (_, index) => personPart(index));
    const parts = await recordedTenantExport({
      streamed: streamedOf([...many, eventPart]),
      record,
      onError,
    });
    expect(records).toEqual([["started", undefined, { ...counts(0), events: 0 }, []]]);
    const kinds: string[] = [];
    for await (const part of parts) kinds.push(part.kind);
    expect(kinds).toEqual(["header", ...many.map(() => "person"), "event", "end"]);
    expect(records[1]).toEqual([
      "ok",
      undefined,
      counts(MAX_ACCESS_PERSONS + 1),
      many
        .slice(0, MAX_ACCESS_PERSONS)
        .map((part) => (part.kind === "person" ? part.person.personId : "")),
    ]);
  });

  it("records a reading stopped early as cancelled, and one that fails as failed, rejecting with it", async () => {
    const cancelled = recorder();
    for await (const part of await recordedTenantExport({
      streamed: streamedOf([personPart(1), eventPart]),
      ...cancelled,
    })) {
      if (part.kind === "person") break;
    }
    expect(cancelled.records.at(-1)).toEqual([
      "cancelled",
      undefined,
      { ...counts(1), events: 0 },
      ["p-001"],
    ]);
    const failing = recorder();
    const boom = new Error("boom");
    const reading = (async () => {
      for await (const _ of await recordedTenantExport({
        streamed: streamedOf([eventPart], boom),
        ...failing,
      }));
    })();
    await expect(reading).rejects.toBe(boom);
    expect(failing.records.at(-1)).toEqual(["failed", boom, { ...counts(0) }, []]);
    expect(failing.errors).toEqual([boom]);
  });
});
