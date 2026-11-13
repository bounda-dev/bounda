import { describe, expect, it } from "vitest";
import type { RestrictedReads } from "../../adapter/storage/restricted-persons.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import { sealedLayoutOf } from "../read-model/sealed-rows.ts";
import type { SealingKeyRing } from "../read-model/sealing-keys.ts";
import { reading } from "./reading.ts";

const fields: FieldsRecord = {
  orderId: f.string().primaryKey(),
  customerId: f.string().optional().person(),
  email: f.string().personal({ category: "profile" }),
};

// One key per person, those named kept by a forgetting; `fetches` says whose keys each read asked for.
const keysOf = (
  retained: readonly string[] = [],
): SealingKeyRing & { readonly fetches: string[][] } => {
  const fetches: string[][] = [];
  const byPerson = new Map<string, Promise<PersonalKey>>();
  const keyOf = (person: string): Promise<PersonalKey> => {
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
    fetches,
    fetch: async (persons) => {
      fetches.push([...persons]);
    },
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

const setUp = async (viewFields: FieldsRecord = fields, retained: readonly string[] = []) => {
  const adapter = memory();
  const layout = sealedLayoutOf({ readModel: "customers", fields: viewFields });
  const storage = await adapter.createReadModel<Record<string, unknown>>({
    name: "customers",
    fields: layout.stored,
    logger: silentLogger,
  });
  const keys = keysOf(retained);
  const stores = (view: "unrestricted" | "retained" | "all" = "unrestricted") =>
    reading({ storage, layout, keys, indexer: null, view });
  return { storage, layout, keys, stores: stores(), storesIn: stores };
};

const noRestrictions: RestrictedReads<Record<string, unknown>> = {
  unrestricted: {} as never,
  retained: {} as never,
  among: async () => new Set(),
};

describe("reading", () => {
  it("seals what it writes, opens what it reads, and notes the person of every row found, repeats included, and of none counted", async () => {
    const { storage, stores, keys } = await setUp();
    const { table } = stores;
    await table.insert({ orderId: "o-1", customerId: "ana", email: "a@x" });
    await table.insert({ orderId: "o-2", customerId: "bo", email: "b@x" });
    await table.upsert({ orderId: "o-3", customerId: "ana", email: "c@x" });
    await expect(table.insert({ orderId: "o-4", email: "d@x" })).rejects.toThrow(
      'Read model "customers": a row writes "email", marked .personal(), without naming its person in "customerId": a personal value is kept under its person\'s key',
    );
    await table.insert({ orderId: "o-4", customerId: "cy", email: "d@x" });
    await table.update({ orderId: "o-3" }, { email: "c2@x" });
    await table.delete({ orderId: "o-2" });
    expect(await table.count()).toBe(3);
    expect(stores.persons).toEqual([]);

    expect(await table.findOne({ orderId: "o-3" })).toEqual({
      orderId: "o-3",
      customerId: "ana",
      email: "c2@x",
    });
    expect(await table.findOne({ orderId: "o-2" })).toBeNull();
    expect(await table.findOne({ orderId: "o-4" })).toMatchObject({ email: "d@x" });
    expect(
      (await table.findMany({ orderBy: { field: "orderId", direction: "asc" } })).map(
        (row) => row.orderId,
      ),
    ).toEqual(["o-1", "o-3", "o-4"]);
    expect(stores.persons).toEqual(["ana", "cy", "ana", "ana", "cy"]);
    // One fetch for every row a read answers, the row's person and its envelopes' alike.
    expect(keys.fetches.at(-1)).toEqual(["ana", "ana", "ana", "ana", "cy", "cy"]);
    const stored = JSON.stringify(await storage.table.findMany());
    expect(stored).not.toContain("c2@x");
    expect(stored).toContain('{\\"$personal\\"');
  });

  it("leaves out of every read the rows of a person restricted as a whole or in a category the read model holds, and those written under a key a forgetting kept, as its view says", async () => {
    const { storage, storesIn } = await setUp(fields, ["cy"]);
    const { table } = storesIn("all");
    for (const [orderId, customerId] of [
      ["o-1", "ana"],
      ["o-2", "bo"],
      ["o-3", "cy"],
      ["o-4", "dan"],
    ] as const) {
      await table.insert({ orderId, customerId, email: `${customerId}@x` });
    }
    await storage.transact({
      subscriber: "test",
      wait: true,
      work: async ({ restrictedPersons }) => {
        await restrictedPersons.request("ana", [{ ground: "legal-claims", categories: null }]);
        await restrictedPersons.request("bo", [
          { ground: "objection-pending", categories: ["marketing"] },
        ]);
      },
    });
    const orders = async (view: "unrestricted" | "retained" | "all") => {
      const stores = storesIn(view);
      return {
        found: (
          await stores.table.findMany({ orderBy: { field: "orderId", direction: "asc" } })
        ).map((row) => [row.orderId, row.email]),
        count: await stores.table.count(),
        ana: await stores.table.findOne({ orderId: "o-1" }),
        retained: [...stores.retained],
      };
    };
    expect(await orders("unrestricted")).toEqual({
      found: [
        ["o-2", "bo@x"],
        ["o-4", "dan@x"],
      ],
      count: 2,
      ana: null,
      retained: [],
    });
    expect(await orders("retained")).toMatchObject({
      found: [
        ["o-2", "bo@x"],
        ["o-3", "cy@x"],
        ["o-4", "dan@x"],
      ],
      count: 3,
      retained: ["cy"],
    });
    expect(await orders("all")).toMatchObject({
      found: [
        ["o-1", "ana@x"],
        ["o-2", "bo@x"],
        ["o-3", "cy@x"],
        ["o-4", "dan@x"],
      ],
      count: 4,
    });
  });

  it("drops from what the client reads the rows of the persons its view leaves out, telling whose a row is by its sealed values when the statement left the person out, and hands its driver through", async () => {
    const { layout, keys, storage } = await setUp();
    const sealer = reading({ storage, layout, keys, indexer: null, view: "all" });
    await sealer.table.insert({ orderId: "o-1", customerId: "ana", email: "a@x" });
    await sealer.table.insert({ orderId: "o-2", customerId: "bo", email: "b@x" });
    await sealer.table.insert({ orderId: "o-3", customerId: "cy", email: "c@x" });
    const stored = await storage.table.findMany({
      orderBy: { field: "orderId", direction: "asc" },
    });
    const found = stored.map(({ orderId, customerId, email }) => ({ orderId, customerId, email }));
    const raw = { driver: true };
    const asked: string[][] = [];
    const stores = reading({
      storage: {
        table: {} as never,
        client: {
          get: async (sql) =>
            sql === "one" ? (found[0] ?? null) : sql === "bo" ? (found[1] ?? null) : null,
          all: async (sql) =>
            sql === "without person"
              ? found.map(({ orderId, email }) => ({ orderId, email }))
              : found,
          raw,
        },
        restricted: {
          ...noRestrictions,
          among: async (persons) => {
            asked.push([...persons]);
            return new Set(persons.filter((person) => person === "bo"));
          },
        },
      },
      layout,
      keys,
      indexer: null,
      view: "unrestricted",
    });
    expect(await stores.client.get("one")).toEqual({
      orderId: "o-1",
      customerId: "ana",
      email: "a@x",
    });
    expect(await stores.client.get("bo")).toBeNull();
    expect(await stores.client.get("none")).toBeNull();
    expect((await stores.client.all("all", [1])).map((row) => row.email)).toEqual(["a@x", "c@x"]);
    expect((await stores.client.all("without person")).map((row) => row.email)).toEqual([
      "a@x",
      "c@x",
    ]);
    expect(asked).toEqual([["ana"], ["bo"], ["ana", "bo", "cy"], ["ana", "bo", "cy"]]);
    expect(stores.client.raw).toBe(raw);
    expect(stores.unattributed).toBe(false);
    expect(stores.persons).toEqual(["ana", "ana", "cy", "ana", "cy"]);
  });

  it("reads every row through the client for a view that leaves out nobody, asking nothing", async () => {
    const { layout, keys } = await setUp();
    const found = [{ orderId: "o-1", customerId: "ana" }];
    const stores = reading({
      storage: {
        table: {} as never,
        client: { get: async () => null, all: async () => found, raw: null },
        restricted: { ...noRestrictions, among: () => Promise.reject(new Error("not asked")) },
      },
      layout,
      keys,
      indexer: null,
      view: "all",
    });
    expect(await stores.client.all("all")).toEqual(found);
  });

  const clearFields: FieldsRecord = {
    orderId: f.string().primaryKey(),
    customerId: f.string().optional().person(),
    email: f.string().personal({ category: "profile", clear: true }),
  };

  it("refuses a row the client reads with a field kept in the clear and without the one marked person, and notes the driver taken as unattributed", async () => {
    const { layout, keys } = await setUp(clearFields);
    const stores = reading({
      storage: {
        table: {} as never,
        client: {
          get: async () => ({ email: "a" }),
          all: async () => [{ orderId: "o-1", email: "a" }],
          raw: null,
        },
        restricted: noRestrictions,
      },
      layout,
      keys,
      indexer: null,
      view: "all",
    });
    await expect(stores.client.all("all")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(stores.client.get("one")).rejects.toThrow(
      'A query of read model "customers" read a field marked .personal({ clear: true }) through client without "customerId", the field marked .person(): select it too, so the rows of restricted persons are left out',
    );
    expect(stores.client.raw).toBeNull();
    expect(stores.unattributed).toBe(true);
  });

  it("leaves out a row the client reads with a field in the clear written under a key a forgetting kept, reading its key field by its primary key", async () => {
    const { layout, keys, storage } = await setUp(clearFields, ["cy"]);
    const writer = reading({ storage, layout, keys, indexer: null, view: "all" });
    await writer.table.insert({ orderId: "o-1", customerId: "ana", email: "a@x" });
    await writer.table.insert({ orderId: "o-3", customerId: "cy", email: "c@x" });
    const rows = [
      { orderId: "o-1", customerId: "ana", email: "a@x" },
      { orderId: "o-3", customerId: "cy", email: "c@x" },
    ];
    const stores = reading({
      storage: {
        table: storage.table,
        client: {
          get: async () => null,
          all: async (sql) =>
            sql === "no key" ? rows.map(({ customerId, email }) => ({ customerId, email })) : rows,
          raw: null,
        },
        restricted: noRestrictions,
      },
      layout,
      keys,
      indexer: null,
      view: "unrestricted",
    });
    expect((await stores.client.all("all")).map((row) => row.orderId)).toEqual(["o-1"]);
    await expect(stores.client.all("no key")).rejects.toThrow(
      'A query of read model "customers" read a field marked .personal({ clear: true }) of a person a forgetting kept a key of through client without "orderId", its primary key: select it too, so the rows under that key are left out',
    );
    const noKept = reading({
      storage: {
        table: storage.table,
        client: {
          get: async () => null,
          all: async () => [{ customerId: "ana", email: "a@x" }],
          raw: null,
        },
        restricted: noRestrictions,
      },
      layout,
      keys,
      indexer: null,
      view: "unrestricted",
    });
    expect(await noKept.client.all("no key")).toEqual([{ customerId: "ana", email: "a@x" }]);
  });
});

describe("reading fields kept in the clear through the client", () => {
  const clearFields: FieldsRecord = {
    orderId: f.string().primaryKey(),
    customerId: f.string().optional().person(),
    email: f.string().personal({ category: "profile", clear: true }),
  };

  it("tells a row a forgetting kept by the key field the statement selected, and reads the key fields of many rows a statement at a time", async () => {
    const { layout, keys, storage } = await setUp(clearFields, ["cy"]);
    const writer = reading({ storage, layout, keys, indexer: null, view: "all" });
    const ids = Array.from({ length: 95 }, (_, index) => `o-${String(index).padStart(3, "0")}`);
    for (const orderId of ids)
      await writer.table.insert({ orderId, customerId: "cy", email: "c@x" });
    await writer.table.insert({ orderId: "z-1", customerId: "ana", email: "a@x" });
    const stored = await storage.table.findMany({
      orderBy: { field: "orderId", direction: "asc" },
    });
    const reader = (
      rows: readonly Record<string, unknown>[],
      view: "unrestricted" | "retained",
    ) => {
      const findMany = storage.table.findMany;
      const asked: number[] = [];
      return {
        asked,
        stores: reading({
          storage: {
            table: {
              ...storage.table,
              findMany: (args) => {
                const listed = (args?.where?.orderId as { in?: readonly unknown[] } | undefined)
                  ?.in;
                asked.push(listed?.length ?? 0);
                return findMany(args);
              },
            },
            client: { get: async () => null, all: async () => rows, raw: null },
            restricted: noRestrictions,
          },
          layout,
          keys,
          indexer: null,
          view,
        }),
      };
    };
    const selected = reader(
      stored.map(({ orderId, customerId, email, email__key }) => ({
        orderId: orderId === "z-1" ? undefined : orderId,
        customerId,
        email,
        email__key,
      })),
      "unrestricted",
    );
    expect(await selected.stores.client.all("with keys")).toEqual([
      { customerId: "ana", email: "a@x" },
    ]);
    expect(selected.asked).toEqual([]);
    const byKey = reader(
      stored.map(({ orderId, customerId, email }) => ({ orderId, customerId, email })),
      "unrestricted",
    );
    expect(await byKey.stores.client.all("without keys")).toEqual([
      { orderId: "z-1", customerId: "ana", email: "a@x" },
    ]);
    expect(byKey.asked).toEqual([90, 5]);
    const legal = reader(
      stored.map(({ customerId, email }) => ({ customerId, email })),
      "retained",
    );
    expect(await legal.stores.client.all("without keys")).toHaveLength(96);
    expect(legal.asked).toEqual([]);
  });
});

describe("reading what a copy has not caught up with", () => {
  it("leaves out a row under a key a forgetting kept even when the statement did not, and reads a row of that person under a key given after", async () => {
    const clearFields: FieldsRecord = {
      orderId: f.string().primaryKey(),
      customerId: f.string().optional().person(),
      email: f.string().personal({ category: "profile", clear: true }),
      note: f.string().optional().personal(),
    };
    const { layout, keys, storage } = await setUp(clearFields, ["cy"]);
    const writer = reading({ storage, layout, keys, indexer: null, view: "all" });
    await writer.table.insert({ orderId: "o-1", customerId: "cy", email: "old@x", note: "n" });
    await writer.table.insert({ orderId: "o-2", customerId: "cy", email: "new@x" });
    await storage.table.update({ orderId: "o-2" }, { email__key: "given-after" });
    const lagging = reading({
      storage: { ...storage, restricted: { ...storage.restricted, unrestricted: storage.table } },
      layout,
      keys,
      indexer: null,
      view: "unrestricted",
    });
    expect((await lagging.table.findMany()).map((row) => row.orderId)).toEqual(["o-2"]);
    const rows = [
      { orderId: "o-1", customerId: "cy", email: "old@x" },
      { orderId: "o-2", customerId: "cy", email: "new@x" },
    ];
    const client = reading({
      storage: {
        table: storage.table,
        client: { get: async () => null, all: async () => rows, raw: null },
        restricted: noRestrictions,
      },
      layout,
      keys,
      indexer: null,
      view: "unrestricted",
    });
    expect((await client.client.all("all")).map((row) => row.orderId)).toEqual(["o-2"]);
  });
});

describe("what the client asks of a read model with fields sealed and in the clear", () => {
  const mixed: FieldsRecord = {
    orderId: f.string().primaryKey(),
    customerId: f.string().optional().person(),
    phone: f.string().optional().personal({ category: "profile", clear: true }),
    mobile: f.string().optional().personal({ category: "profile", clear: true }),
    note: f.string().optional().personal(),
  };

  const clientOver = async (
    rows: readonly Record<string, unknown>[],
    retained: readonly string[],
  ) => {
    const { layout, keys, storage } = await setUp(mixed, retained);
    return {
      layout,
      keys,
      storage,
      stores: (view: "unrestricted" | "all" = "unrestricted") =>
        reading({
          storage: {
            table: storage.table,
            client: { get: async () => null, all: async () => rows, raw: null },
            restricted: noRestrictions,
          },
          layout,
          keys,
          indexer: null,
          view,
        }),
    };
  };

  it("asks for neither the person nor the primary key of a row with sealed values alone, nor of one whose fields in the clear it did not select", async () => {
    const rows = [
      { note: null },
      { orderId: "o-1", customerId: "cy" },
      { customerId: "cy", note: null },
    ];
    const { stores, storage } = await clientOver(rows, ["cy"]);
    await storage.table.upsert({
      orderId: "o-1",
      customerId: "cy",
      phone: "1",
      phone__key: "retained:k",
    });
    expect(await stores().client.all("")).toEqual(rows);
  });

  it("refuses the rows of a person a forgetting kept a key of when any of them lacks its primary key, and leaves out a row with any field in the clear under that key", async () => {
    const partial = await clientOver(
      [
        { orderId: "o-1", customerId: "cy", phone: "1" },
        { customerId: "cy", phone: "2" },
      ],
      ["cy"],
    );
    await expect(partial.stores().client.all("")).rejects.toThrow("its primary key");
    const anonymous = await clientOver([{ orderId: "o-1", phone: "1" }], []);
    await expect(anonymous.stores().client.all("")).rejects.toThrow("the field marked .person()");
    const { stores, storage } = await clientOver(
      [{ orderId: "o-1", customerId: "cy", phone: "1", mobile: "2" }],
      ["cy"],
    );
    await storage.table.upsert({
      orderId: "o-1",
      customerId: "cy",
      phone: "1",
      phone__key: "plain",
      mobile: "2",
      mobile__key: "retained:k",
    });
    expect(await stores().client.all("")).toEqual([]);
  });

  it("notes whose rows a view that leaves out nobody read, and fetches the keys of every person a row names", async () => {
    const { stores, keys } = await clientOver(
      [
        { orderId: "o-1", customerId: "ana", phone: "1" },
        { orderId: "o-2", note: null },
      ],
      [],
    );
    const all = stores("all");
    await all.client.all("");
    expect(all.persons).toEqual(["ana"]);
    expect(keys.fetches.at(-1)).toEqual(["ana"]);
  });
});
