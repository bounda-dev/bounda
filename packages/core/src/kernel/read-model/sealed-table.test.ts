import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import { sealedClient } from "./sealed-client.ts";
import { applyForgetting, isForgetting } from "./sealed-forgetting.ts";
import { parseEnvelope, sealedLayoutOf } from "./sealed-rows.ts";
import { settledPatch } from "./sealed-settle.ts";
import { sealedTable, storedWhere } from "./sealed-table.ts";
import type { SealingKeys } from "./sealing-keys.ts";

const fields: FieldsRecord = {
  customerId: f.string().primaryKey().person(),
  email: f.string().personal().unique(),
  note: f.string().optional().personal(),
  born: f.date().optional().personal().index(),
  tags: f.json<readonly string[]>().optional().personal().index(),
  plan: f.string(),
};

// An index that reads as what it indexes, so a test sees which value a condition names.
const indexer: BlindIndexer = {
  index: async ({ readModel, field, value }) => `${readModel}.${field}=${JSON.stringify(value)}`,
};

const keysOf = (retained: readonly string[] = []): SealingKeys => {
  const byPerson = new Map<string, Promise<PersonalKey>>();
  const keyOf = (person: string) => {
    const known = byPerson.get(person);
    if (known !== undefined) return known;
    const created = createDisposableKey().then((key) => ({
      ...key,
      retained: retained.includes(person),
    }));
    byPerson.set(person, created);
    return created;
  };
  return {
    forWrite: (person) => (person === null ? createDisposableKey() : keyOf(person)),
    forOpen: async (person, fingerprint) => {
      const key = await keyOf(person);
      return key.fingerprint === fingerprint ? key : null;
    },
    kept: async (person) => retained.includes(person),
    categoryOf: async (person, fingerprint) =>
      (await keyOf(person)).fingerprint === fingerprint ? "default" : null,
  };
};

const setUp = async (retained: readonly string[] = []) => {
  const layout = sealedLayoutOf({ readModel: "customers", fields });
  const storage = await memory().createReadModel<Record<string, unknown>>({
    name: "customers",
    fields: layout.stored,
    logger: silentLogger,
  });
  const context = { layout, keys: keysOf(retained), indexer, event: () => null };
  return { layout, storage, context, table: sealedTable({ context, table: storage.table }) };
};

describe("storedWhere", () => {
  it("matches a sealed field through its blind index, by equality, ne or in, and leaves other fields as they are", async () => {
    const { context } = await setUp();
    expect(
      await storedWhere({
        context,
        where: { email: "a@x", plan: "pro", born: { ne: null }, tags: ["a"] },
      }),
    ).toEqual({
      email__index: 'customers.email="a@x"',
      plan: "pro",
      born__index: { ne: null },
      tags__index: 'customers.tags=["a"]',
    });
    expect(await storedWhere({ context, where: { email: { in: ["a@x", "b@x"] } } })).toEqual({
      email__index: { in: ['customers.email="a@x"', 'customers.email="b@x"'] },
    });
    expect(await storedWhere({ context, where: { email: null } })).toEqual({ email__index: null });
    expect(await storedWhere({ context, where: undefined })).toBeUndefined();
  });

  it("refuses a sealed field without a blind index, and a range on one with it", async () => {
    const { context } = await setUp();
    await expect(storedWhere({ context, where: { note: "x" } })).rejects.toThrow(
      'Read model "customers": field "note" is sealed at rest and has no blind index, so where cannot match it; give it .index() or .unique()',
    );
    await expect(storedWhere({ context, where: { born: { gt: new Date(0) } } })).rejects.toThrow(
      'Read model "customers": field "born" is sealed at rest, so where matches it by equality, ne or in, never by "gt"',
    );
  });
});

describe("sealedTable", () => {
  it("writes sealed values with their key and index, and reads them back opened, typed as the view declares them", async () => {
    const { storage, table } = await setUp();
    const born = new Date("1990-01-02T00:00:00.000Z");
    await table.upsert({ customerId: "ana", email: "a@x", born, tags: ["a"], plan: "pro" });
    await table.insert({ customerId: "bo", email: "b@x", plan: "free" });
    const [stored] = await storage.table.findMany({ where: { customerId: "ana" } });
    expect(String(stored?.email)).not.toContain("a@x");
    expect(stored).toMatchObject({
      email__index: 'customers.email="a@x"',
      born__index: `customers.born=${JSON.stringify(born)}`,
      tags__index: 'customers.tags=["a"]',
      plan: "pro",
    });
    expect(stored?.note).toBeUndefined();
    expect(await table.findOne({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: "a@x",
      born,
      tags: ["a"],
      plan: "pro",
    });
    expect(await table.findOne({ email: "b@x" })).toMatchObject({ customerId: "bo" });
    expect(await table.count({ email: { ne: "a@x" } })).toBe(1);
  });

  it("seals a patch under each row's person, reading the rows it changes when it does not name the person", async () => {
    const { table, storage } = await setUp();
    await table.upsert({ customerId: "ana", email: "a@x", plan: "pro" });
    await table.upsert({ customerId: "bo", email: "b@x", plan: "pro" });
    await table.update({ plan: "pro" }, { note: "both" });
    await table.update({ customerId: "ana" }, { customerId: "ana", note: "ana's" });
    await table.update({ customerId: "bo" }, { plan: "free" });
    expect(
      (await table.findMany({ orderBy: { field: "customerId", direction: "asc" } })).map(
        ({ customerId, note, plan }) => [customerId, note, plan],
      ),
    ).toEqual([
      ["ana", "ana's", "pro"],
      ["bo", "both", "free"],
    ]);
    for (const row of await storage.table.findMany()) {
      expect(parseEnvelope(row.note)?.$personal.person).toBe(row.customerId);
    }
    await table.update({ customerId: "bo" }, { note: "bo's" });
    expect((await table.findOne({ customerId: "ana" }))?.note).toBe("ana's");
    expect(
      (await table.findMany({ where: { email: "b@x" } })).map(({ customerId }) => customerId),
    ).toEqual(["bo"]);
    await table.delete({ email: "a@x" });
    expect(await table.count()).toBe(1);
  });

  it("refuses to sort by a sealed field", async () => {
    const { table } = await setUp();
    await expect(table.findMany({ orderBy: { field: "email", direction: "asc" } })).rejects.toThrow(
      'Read model "customers": field "email" is sealed at rest, so findMany cannot sort by it; keep it in the clear with .personal({ clear: true }) to sort by it in SQL',
    );
  });

  it("reads a value that is no envelope as null, nothing in the clear out of a sealed column", async () => {
    const { storage, table } = await setUp();
    await storage.table.upsert({ customerId: "ana", email: "in the clear", plan: "pro" });
    expect(await table.findOne({ customerId: "ana" })).toMatchObject({ email: null });
  });
});

describe("sealedClient", () => {
  it("computes the blind index a hand-written statement compares, for a field that has one alone", async () => {
    const { context, storage } = await setUp();
    // Typed from a view, the client takes only fields with a blind index; this one is untyped.
    const blindIndex = sealedClient({ context, client: storage.client }).blindIndex as (
      field: string,
      value: unknown,
    ) => Promise<string>;
    expect(await blindIndex("email", "a@x")).toBe('customers.email="a@x"');
    await expect(blindIndex("note", "x")).rejects.toThrow(
      'Read model "customers": field "note" has no blind index; only a field marked .personal() with .index() or .unique() has one',
    );
  });
});

describe("applyForgetting", () => {
  const forgetting = (payload: object): StoredEvent => ({
    id: "e-9",
    aggregateType: "bounda",
    aggregateId: "ana",
    version: 1,
    position: 9,
    type: "PersonalDataForgotten",
    payload: { personId: "ana", categories: [], retained: [], expired: [], ...payload },
    person: "ana",
    timestamp: "2026-01-01T00:00:00.000Z",
    metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: true },
  });

  it("marks the keys a forgetting kept, empties the index of the values under the keys it destroyed, and leaves a key given after alone", async () => {
    const { layout, storage, table, context } = await setUp();
    await table.upsert({ customerId: "ana", email: "a@x", plan: "pro" });
    await table.upsert({ customerId: "bo", email: "b@x", plan: "pro" });
    const [before] = await storage.table.findMany({ where: { customerId: "ana" } });
    const fingerprint = String(before?.email__key);
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting({ retained: ["default"], fingerprints: [fingerprint] }),
    });
    const [kept] = await storage.table.findMany({ where: { customerId: "ana" } });
    expect(kept?.email__key).toBe(`retained:${fingerprint}`);
    expect(kept?.email__index).toBe('customers.email="a@x"');
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting({ expired: ["default"], fingerprints: [fingerprint] }),
    });
    const [expired] = await storage.table.findMany({ where: { customerId: "ana" } });
    expect(expired?.email__key).toBe("forgotten");
    expect(expired?.email__index).toBeUndefined();
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting({ categories: ["default"], fingerprints: ["another"] }),
    });
    const [bo] = await storage.table.findMany({ where: { customerId: "bo" } });
    expect(bo?.email__index).toBe('customers.email="b@x"');
  });

  it("empties the index of every value of the person in a category a forgetting recorded without fingerprints forgot", async () => {
    const { layout, storage, table, context } = await setUp();
    await table.upsert({ customerId: "ana", email: "a@x", plan: "pro" });
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting({ categories: ["default"] }),
    });
    const [row] = await storage.table.findMany({ where: { customerId: "ana" } });
    expect(row?.email__index).toBeUndefined();
    expect(row?.email__key).toEqual(expect.any(String));
  });
});

describe("settledPatch", () => {
  it("seals a value left in the clear of a row that names no person under a key no one keeps, never throwing", async () => {
    const { context } = await setUp();
    const patch = await settledPatch({
      context,
      stored: { customerId: undefined, email: "in the clear", plan: "pro" },
    });
    expect(String(patch?.email)).toMatch(/^\{"\$personal":/);
    expect(String(patch?.email)).not.toContain("in the clear");
    expect(patch?.email__key).toEqual(expect.any(String));
    expect(patch?.email__index).toBeNull();
  });

  it("seals a value left in the clear of a person under their key, with its index, and leaves a settled row alone", async () => {
    const { context, storage, table } = await setUp();
    const patch = await settledPatch({
      context,
      stored: { customerId: "ana", email: "a@x", plan: "pro" },
    });
    expect(patch).toMatchObject({ email__index: 'customers.email="a@x"' });
    await table.upsert({ customerId: "bo", email: "b@x", plan: "pro" });
    const [settled] = await storage.table.findMany({ where: { customerId: "bo" } });
    expect(await settledPatch({ context, stored: settled ?? {} })).toBeNull();
  });
});

describe("sealedTable and storedWhere at their edges", () => {
  it("matches a JSON field's blind index by the whole value, and a field in the clear as it is", async () => {
    const { context } = await setUp();
    expect(await storedWhere({ context, where: { tags: { ne: ["a"] } } })).toEqual({
      tags__index: 'customers.tags={"ne":["a"]}',
    });
    expect(await storedWhere({ context, where: { email: undefined } })).toEqual({
      email__index: undefined,
    });
    expect(await storedWhere({ context, where: { email: { in: "a@x" } } })).toEqual({
      email__index: { in: 'customers.email="a@x"' },
    });
  });

  it("sorts by a field that is not sealed, reads and writes the whole table without a where, and opens for a projection what a forgetting kept", async () => {
    const { table, storage } = await setUp(["ana"]);
    await table.upsert({ customerId: "ana", email: "a@x", note: "n", plan: "pro" });
    await table.upsert({ customerId: "ana", email: "a@x", plan: "pro" });
    expect(await table.findOne({ customerId: "ana" })).toEqual({
      customerId: "ana",
      email: "a@x",
      plan: "pro",
    });
    expect((await storage.table.findMany())[0]?.note).toBeUndefined();
    await table.update({}, { note: "everyone" });
    expect(await table.findMany({ orderBy: { field: "plan", direction: "asc" } })).toEqual([
      { customerId: "ana", email: "a@x", note: "everyone", plan: "pro" },
    ]);
    await table.update({}, { plan: "free" });
    expect(await table.count()).toBe(1);
    expect(await table.findMany({ where: { email: { ne: "x" } } })).toHaveLength(1);
    expect(await table.findOne({ customerId: "bo" })).toBeNull();
  });

  it("finds the persons a patch changes in the table unfiltered, and writes there", async () => {
    const { context, storage } = await setUp();
    const filtered = storage.restricted.unrestricted;
    const hiding = { ...filtered, findMany: async () => [] };
    const table = sealedTable({ context, table: hiding, unfiltered: storage.table });
    await sealedTable({ context, table: storage.table }).upsert({
      customerId: "ana",
      email: "a@x",
      plan: "pro",
    });
    await table.update({ plan: "pro" }, { note: "seen" });
    const [row] = await storage.table.findMany();
    expect(String(row?.note)).toMatch(/^\{"\$personal":/);
  });
});

describe("applyForgetting at its edges", () => {
  const forgetting = (aggregateType: string, payload: object): StoredEvent => ({
    id: "e",
    aggregateType,
    aggregateId: "ana",
    version: 1,
    position: 1,
    type: "PersonalDataForgotten",
    payload: { personId: "ana", categories: [], retained: [], expired: [], ...payload },
    person: "ana",
    timestamp: "2026-01-01T00:00:00.000Z",
    metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: true },
  });

  it("tells a forgetting by its aggregate and type", () => {
    expect(isForgetting(forgetting("bounda", {}))).toBe(true);
    expect(isForgetting(forgetting("customer", {}))).toBe(false);
    expect(isForgetting({ ...forgetting("bounda", {}), type: "ProcessingRestricted" })).toBe(false);
  });

  it("changes only the person's rows, in the categories the forgetting names, and nothing of a read model without a person field", async () => {
    const { layout, storage, context } = await setUp();
    for (const customerId of ["ana", "bo"]) {
      await storage.table.upsert({
        customerId,
        email: "x",
        email__key: "f-1",
        email__index: `i-${customerId}`,
        plan: "pro",
      });
    }
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting("bounda", { categories: ["invoices"], fingerprints: ["f-1"] }),
    });
    expect((await storage.table.findMany()).map((row) => row.email__index)).toEqual([
      "i-ana",
      "i-bo",
    ]);
    await applyForgetting({
      layout,
      table: storage.table,
      keys: context.keys,
      event: forgetting("bounda", { categories: ["default"], fingerprints: ["f-1"] }),
    });
    expect(
      (await storage.table.findMany({ orderBy: { field: "customerId", direction: "asc" } })).map(
        (row) => row.email__index ?? null,
      ),
    ).toEqual([null, "i-bo"]);
    const unowned = sealedLayoutOf({
      readModel: "notes",
      fields: { id: f.string().primaryKey(), note: f.string() },
    });
    const failing = { ...storage.table, update: () => Promise.reject(new Error("touched")) };
    await applyForgetting({
      layout: unowned,
      table: failing,
      keys: context.keys,
      event: forgetting("bounda", { categories: ["default"] }),
    });
  });
});

describe("applyForgetting statements", () => {
  const counting = (table: Parameters<typeof applyForgetting>[0]["table"]) => {
    const wheres: unknown[] = [];
    return {
      wheres,
      table: {
        ...table,
        update: (where: Parameters<typeof table.update>[0], patch: Record<string, unknown>) => {
          wheres.push(where);
          return table.update(where, patch);
        },
      },
    };
  };
  const event = (payload: object): StoredEvent => ({
    id: "e",
    aggregateType: "bounda",
    aggregateId: "ana",
    version: 1,
    position: 1,
    type: "PersonalDataForgotten",
    payload: { personId: "ana", categories: [], retained: [], expired: [], ...payload },
    person: "ana",
    timestamp: "2026-01-01T00:00:00.000Z",
    metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: true },
  });

  it("runs one statement per personal field of a category forgotten, whatever the fingerprints, and marks a kept key only in the fields of its category", async () => {
    const { layout, storage } = await setUp();
    const forgotten = counting(storage.table);
    await applyForgetting({
      layout,
      table: forgotten.table,
      keys: { categoryOf: async () => null },
      event: event({ categories: ["default"], fingerprints: ["f-1", "f-2", "f-3"] }),
    });
    expect(forgotten.wheres).toHaveLength(layout.personal.length);
    expect(forgotten.wheres[0]).toEqual({
      customerId: "ana",
      email__key: { in: ["f-1", "f-2", "f-3", "retained:f-1", "retained:f-2", "retained:f-3"] },
    });
    const kept = counting(storage.table);
    await applyForgetting({
      layout,
      table: kept.table,
      keys: {
        categoryOf: async (_, fingerprint) =>
          fingerprint === "f-1" ? "default" : fingerprint === "f-2" ? "invoices" : null,
      },
      event: event({ retained: ["default"], fingerprints: ["f-1", "f-2", "f-3"] }),
    });
    expect(kept.wheres).toEqual(
      layout.personal.map(({ keyField }) => ({ customerId: "ana", [keyField]: "f-1" })),
    );
    const none = counting(storage.table);
    await applyForgetting({
      layout,
      table: none.table,
      keys: { categoryOf: () => Promise.reject(new Error("not asked")) },
      event: event({ categories: ["default"], retained: [], fingerprints: ["f-1"] }),
    });
    expect(none.wheres).toHaveLength(layout.personal.length);
  });
});
