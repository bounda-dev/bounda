import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import { createNodeSqliteAdapter } from "../../adapter/sqlite/node-sqlite.ts";
import type { InspectedTable } from "../../adapter/storage/inspection.ts";
import type { Table } from "../../adapter/storage/table.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs, PayloadArgs } from "../../modules/payload.ts";
import type { RedactedFields } from "../../modules/redaction.ts";
import type { Registry } from "../../modules/registry.ts";
import type { FieldsArgs } from "../../modules/view.ts";
import { createTestApp, expectForgotten, expectRedacted } from "../../testing/index.ts";
import { settledMark } from "../read-model/sealed-settle.ts";
import { epochMark, epochNumber } from "./blind-index.ts";
import { RESEAL_SWITCH_MS } from "./reseal.ts";

interface CustomerRow {
  readonly customerId: string;
  readonly email: string | null;
  readonly plan: string;
}

type Events = Record<string, (payload: unknown) => unknown>;

const DAY = 86_400_000;

const registry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({ email: personal(z.string()), plan: notPersonal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z, personal, notPersonal }: CommandPayloadArgs) =>
              z.object({
                customerId: notPersonal(z.string()),
                email: personal(z.string()),
                plan: notPersonal(z.string()),
              }),
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
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {
    // Sealed without a blind index: rebuilt all the same.
    notes: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal(),
        }),
      },
      projections: {
        customer: {
          customerRegistered: {
            project: ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { email: string | null } };
              table: Table<{ customerId: string; email: string | null }>;
            }) => table.upsert({ customerId: event.aggregateId, email: event.payload.email }),
          },
        },
      },
      queries: {},
    },
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal().unique(),
          plan: f.string().notPersonal(),
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
                email: event.payload.email,
                plan: event.payload.plan,
              }),
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
        others: {
          payload: ({ z }: PayloadArgs) => z.object({ email: z.string() }),
          repository: ({ email, table }: { email: string; table: Table<CustomerRow> }) =>
            table.findMany({
              where: { email: { ne: email } },
              orderBy: { field: "customerId", direction: "asc" },
            }),
          handler: ({ repositoryData }: { repositoryData: readonly CustomerRow[] }) =>
            repositoryData.map(({ customerId }) => customerId),
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
  for (const stop of stops.splice(0)) await stop();
});

// Every fingerprint a table names: of the keys, in envelopes, in `persons` and key fields.
const fingerprintsIn = (tables: readonly InspectedTable[], fingerprints: ReadonlySet<string>) =>
  tables.flatMap(({ name, rows }) =>
    rows.flatMap((row) => {
      const text = JSON.stringify(row);
      return [...fingerprints].filter((fingerprint) => text.includes(fingerprint)).map(() => name);
    }),
  );

const setUp = async (adapter: Adapter, batchSize?: number) => {
  const logged: string[] = [];
  const { app, clock } = await createTestApp({
    registry,
    adapter,
    ...(batchSize === undefined ? {} : { config: { runtime: { dispatcher: { batchSize } } } }),
    logger: {
      debug: () => {},
      info: (message) => logged.push(message),
      warn: () => {},
      error: () => {},
    },
  });
  stops.push(() => app.stop());
  const commands = app.commands as unknown as Record<
    string,
    (payload: unknown, options?: Record<string, unknown>) => Promise<unknown>
  >;
  const queries = app.queries as unknown as Record<string, (payload?: unknown) => Promise<unknown>>;
  const register = async (
    customerId: string,
    options?: Record<string, unknown>,
    email = `${customerId}@example.com`,
  ) => {
    const answer = await commands.registerCustomer?.({ customerId, email, plan: "pro" }, options);
    await app.runUntilIdle();
    return answer;
  };
  const emailOf = async (customerId: string) =>
    (await app.exportPersonalData(customerId)).events[0]?.data;
  const keyFingerprints = async (store: "personalKeys" | "indexKeys") =>
    new Set(
      (await adapter.inspect())
        .filter((table) => table.store === store)
        .flatMap(({ rows }) => rows.map(({ fingerprint }) => String(fingerprint))),
    );
  // Through every step but the wait for the answers filed under the database's previous key.
  const reseal = async () => {
    await app.rotateTenantKey({ reseal: true });
    await app.runUntilIdle();
    clock.advance(RESEAL_SWITCH_MS);
    await app.runUntilIdle();
  };
  return { app, clock, adapter, logged, queries, register, emailOf, keyFingerprints, reseal };
};

// The memory adapter hands out the stores the app writes, which a test can make fail.
describe("a restore under a running app", () => {
  it("reads the database's keys again when told of a restore, and logs a read that fails", async () => {
    const adapter = memory();
    const errors: (readonly [string, unknown])[] = [];
    const { app } = await createTestApp({
      registry,
      adapter,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message, fields) => errors.push([message, fields]),
      },
    });
    stops.push(() => app.stop());
    const stores = await adapter.createStorage();
    const previous = vi.spyOn(stores.indexKeys, "previous");
    await app.restored();
    expect(previous).toHaveBeenCalled();
    const down = new Error("the database is down");
    previous.mockRejectedValueOnce(down);
    await app.restored();
    expect(errors).toContainEqual([
      "the database's key could not be read again",
      expect.objectContaining({ errorMessage: "the database is down" }),
    ]);
  });
});

describe.each(adapters)("a reseal of the tenant's personal data, %s", (_, adapterOf) => {
  it("replaces every key that seals personal data, seals everything again under the new ones and destroys the old", async () => {
    const { app, clock, adapter, queries, register, emailOf, keyFingerprints, reseal } =
      await setUp(adapterOf());
    await register("ana", { idempotencyKey: "k-ana" });
    await register("bob");
    await register("cy", { delay: "1d" });
    // An answer sealed under a key the database no longer holds opens nowhere: it is erased.
    const stores = await adapter.createStorage();
    const lost = {
      $sealed: { salt: "AAAAAAAAAAAAAAAAAAAAAA==", data: "AAAAAAAAAAAAAAAAAAAAAA==" },
    };
    await stores.idempotencyStore.put({
      key: "lost",
      answer: lost,
      expiresAt: new Date(clock.now().getTime() + 3 * DAY).toISOString(),
      persons: [],
      now: clock.now(),
    });
    const old = await keyFingerprints("personalKeys");
    const oldIndex = await keyFingerprints("indexKeys");
    const events = (await adapter.inspect()).find(({ store }) => store === "events")?.rows.length;
    const older = (await app.status()).keyRotation?.kid;
    await reseal();
    const status = (await app.status()).keyRotation?.reseal;
    expect(status).toMatchObject({ step: "expiring", superseded: 0 });
    const tables = await adapter.inspect();
    // No old key's fingerprint is left but in the record of what superseded what, and the
    // database's previous key, kept for the answers filed under it.
    expect(
      fingerprintsIn(
        tables.filter(({ store }) => store !== "supersededKeys"),
        old,
      ),
    ).toEqual([]);
    const indexKeys = tables.find(({ store }) => store === "indexKeys")?.rows ?? [];
    expect(indexKeys.map(({ scope }) => scope).sort()).toEqual(["app", "previous"]);
    expect(
      fingerprintsIn(
        tables.filter(({ store }) => store !== "indexKeys"),
        oldIndex,
      ),
    ).toEqual([]);
    const superseded = tables.find(({ store }) => store === "supersededKeys")?.rows ?? [];
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.every((row) => row.key === null && row.kid === null)).toBe(true);
    expect(await emailOf("ana")).toEqual({ email: "ana@example.com" });
    expect(await queries.byEmail?.({ email: "bob@example.com" })).toEqual({
      customerId: "bob",
      email: "bob@example.com",
      plan: "pro",
    });
    // The answer remembered before the reseal still answers, without running again.
    await register("ana", { idempotencyKey: "k-ana" });
    expect((await adapter.inspect()).find(({ store }) => store === "events")?.rows.length).toBe(
      events,
    );
    // The command scheduled before runs with its payload opened under the new keys.
    clock.advance(DAY);
    await app.runUntilIdle();
    expect(await queries.byEmail?.({ email: "cy@example.com" })).toMatchObject({
      customerId: "cy",
    });
    expect(await app.retireTenantKeys()).toContain(older);
    expect(
      (await stores.idempotencyStore.get({ key: "lost", now: clock.now() }))?.answer,
    ).toBeNull();
    // Once the old keys are destroyed, the tenant's key rotates again; another reseal waits.
    await expect(app.rotateTenantKey({ reseal: true })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "A reseal of the tenant's personal data is under way: another one can start once it is complete",
      issues: [{ path: ["reseal"], message: "Expected no reseal under way" }],
    });
    await app.rotateTenantKey();
    await app.runUntilIdle();
    // The database's previous key goes once the last answer filed under it expires.
    clock.advance(2 * DAY);
    await app.runUntilIdle();
    expect((await app.status()).keyRotation?.reseal).toMatchObject({
      step: "complete",
      startedAt: null,
      completedAt: expect.any(String),
    });
    expect((await adapter.inspect()).find(({ store }) => store === "indexKeys")?.rows).toHaveLength(
      1,
    );
    expect(await queries.byEmail?.({ email: "ana@example.com" })).toMatchObject({
      customerId: "ana",
    });
  });

  it("rebuilds a table under the database's key in force, starting over one paused under the previous, and marks which", async () => {
    const { app, adapter, register } = await setUp(adapterOf());
    await register("ana");
    await register("bob");
    await register("cy");
    const stores = await adapter.createStorage();
    const settled = await stores.checkpointStore.get(settledMark("customers"));
    expect(await app.rebuildReadModel("customers", { maxEvents: 1 })).toMatchObject({
      done: false,
    });
    await app.rotateTenantKey({ reseal: true });
    expect(await app.rebuildReadModel("customers")).toEqual({
      events: 3,
      position: 3,
      done: true,
    });
    const inForce = (await adapter.inspect())
      .find(({ store }) => store === "indexKeys")
      ?.rows.find(({ scope }) => scope === "app");
    expect(await stores.checkpointStore.get(epochMark("customers"))).toBe(
      await epochNumber(String(inForce?.fingerprint)),
    );
    const resettled = await stores.checkpointStore.get(settledMark("customers"));
    expect(resettled).not.toBe(settled);
    // As an instance that starts would settle it: it leaves it as it is.
    const { app: started } = await createTestApp({ registry, adapter });
    stops.push(() => started.stop());
    await started.runUntilIdle();
    expect(await stores.checkpointStore.get(settledMark("customers"))).toBe(resettled);
  });

  it("rebuilds the read models in slices of several of the dispatcher's batches", async () => {
    const { app, register, reseal } = await setUp(adapterOf(), 1);
    await register("ana");
    await register("bob");
    await reseal();
    expect((await app.status()).keyRotation?.reseal).toMatchObject({ step: "complete" });
  });

  it("indexes a table first written while the keys are replaced under the new key, and marks it", async () => {
    const { app, adapter, register, queries } = await setUp(adapterOf());
    await app.rotateTenantKey({ reseal: true });
    await register("ana");
    await register("bob");
    const inForce = (await adapter.inspect())
      .find(({ store }) => store === "indexKeys")
      ?.rows.find(({ scope }) => scope === "app");
    const stores = await adapter.createStorage();
    expect(await stores.checkpointStore.get(epochMark("customers"))).toBe(
      await epochNumber(String(inForce?.fingerprint)),
    );
    expect(await queries.byEmail?.({ email: "bob@example.com" })).toMatchObject({
      customerId: "bob",
    });
  });

  it("serves every read while the keys are replaced, and refuses another rotation and the retirement meanwhile", async () => {
    const { app, clock, adapter, logged, queries, register, emailOf } = await setUp(adapterOf());
    await register("ana");
    await app.rotateTenantKey({ reseal: true });
    const rotatedAt = clock.now().getTime();
    expect(logged).toContain(
      "tenant key rotated; every key that seals personal data is replaced in the background",
    );
    // The database's key is replaced by the call itself, the old one kept as the previous.
    const indexKeys = (await adapter.inspect()).find(({ store }) => store === "indexKeys");
    expect(indexKeys?.rows.map(({ scope }) => scope).sort()).toEqual(["app", "previous"]);
    await expect(app.rotateTenantKey()).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "A reseal keeps the persons' keys it replaced: the tenant's key rotates again once it destroys them",
      issues: [{ path: [], message: "Expected no reseal keeping keys" }],
    });
    await expect(app.rotateTenantKey({ reseal: true })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(app.retireTenantKeys()).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "A reseal keeps the persons' keys it replaced, wrapped under an older version of the tenant's key: wait for it to destroy them",
      issues: [{ path: [], message: "Expected no reseal keeping keys" }],
    });
    await app.runUntilIdle();
    expect((await app.status()).keyRotation?.reseal).toMatchObject({ step: "replacing" });
    expect(await app.nextDueAt()).toEqual(new Date(rotatedAt + RESEAL_SWITCH_MS));
    // The keys are replaced, nothing is sealed again yet: the old ones still open it.
    expect(await emailOf("ana")).toEqual({ email: "ana@example.com" });
    expect(await queries.byEmail?.({ email: "ana@example.com" })).toMatchObject({
      customerId: "ana",
    });
    await register("bob");
    expect(await queries.byEmail?.({ email: "bob@example.com" })).toMatchObject({
      customerId: "bob",
    });
    // A table under the database's previous key is matched under either.
    expect(await queries.others?.({ email: "ana@example.com" })).toEqual(["bob"]);
  });

  it("keeps forgotten a person forgotten while the keys are replaced, and redacted a value redacted meanwhile", async () => {
    const { app, clock, register, emailOf } = await setUp(adapterOf());
    await register("ana");
    await register("bob");
    const [registration] = (await app.exportPersonalData("bob")).events;
    if (registration === undefined) throw new Error("bob is not registered");
    await app.rotateTenantKey({ reseal: true });
    await app.runUntilIdle();
    await app.forget("ana");
    const target: RedactedFields = {
      aggregateType: registration.aggregateType,
      aggregateId: registration.aggregateId,
      type: registration.type,
      id: registration.id,
      fields: ["email"],
    };
    await app.redact("bob", { events: [target] });
    await app.runUntilIdle();
    clock.advance(RESEAL_SWITCH_MS);
    await app.runUntilIdle();
    expect((await app.status()).keyRotation?.reseal).toMatchObject({ superseded: 0 });
    await expectForgotten(app, "ana");
    await expectRedacted(app, "bob");
    expect(await emailOf("bob")).toEqual({ email: null });
  });
});
