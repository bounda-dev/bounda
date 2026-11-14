import { describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";
import { createDisposableKey, type PersonalKey, seal } from "../personal-data/crypto.ts";
import { eachPerson } from "../test-support.ts";
import { parseEnvelope, sealedLayoutOf } from "./sealed-rows.ts";
import {
  layoutDigest,
  settledMark,
  settledPatch,
  settlePage,
  settleUnsettled,
} from "./sealed-settle.ts";
import { openReadModelSealing, settleReadModels } from "./sealing.ts";
import type { SealingKeys } from "./sealing-keys.ts";

const fields: FieldsRecord = {
  customerId: f.string().primaryKey().optional().person(),
  email: f.string().personal().index(),
  born: f.date().optional().personal(),
  tags: f.json<readonly string[]>().optional().personal(),
  joined: f.date().optional().personal({ clear: true }),
  phone: f.string().personal({ clear: true }),
  plan: f.string().optional(),
};

const indexer: BlindIndexer = {
  index: async ({ field, value }) => `${field}=${JSON.stringify(value)}`,
};

interface Keys {
  readonly keys: SealingKeys;
  readonly keyOf: (person: string) => Promise<PersonalKey>;
}

// One key per person, those named in `retained` kept by a forgetting, those in `gone` destroyed.
const keysOf = (retained: readonly string[] = [], gone: readonly string[] = []): Keys => {
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
    keyOf,
    keys: {
      forWrite: (person) => (person === null ? createDisposableKey() : keyOf(person)),
      forOpen: async (person, fingerprint) => {
        if (gone.includes(person)) return null;
        const key = await keyOf(person);
        return key.fingerprint === fingerprint ? key : null;
      },
      kept: async (person) => retained.includes(person),
      categoryOf: async (person, fingerprint) =>
        (await keyOf(person)).fingerprint === fingerprint ? "default" : null,
    },
  };
};

const layout = sealedLayoutOf({ readModel: "customers", fields });
const contextOf = (keys: SealingKeys) => ({ layout, keys, indexer, event: () => null });

const sealedFor = async (key: PersonalKey, person: string, value: unknown) =>
  JSON.stringify(await seal({ key, person, category: "default", value }));

describe("settledPatch", () => {
  it("seals values left in the clear in sealed fields as the field's type reads them, under the row's person", async () => {
    const { keys, keyOf } = keysOf();
    const key = await keyOf("ana");
    const patch = await settledPatch({
      context: contextOf(keys),
      stored: {
        customerId: "ana",
        email: "a@x",
        born: "1990-01-02T00:00:00.000Z",
        tags: '["a"]',
        phone: "555",
        phone__key: key.fingerprint,
      },
    });
    expect(patch).toMatchObject({
      email__key: key.fingerprint,
      email__index: 'email="a@x"',
      born__key: key.fingerprint,
      tags__key: key.fingerprint,
    });
    expect(patch).not.toHaveProperty("phone");
    expect(patch).not.toHaveProperty("born__index");
    const opened = async (field: string) => {
      const envelope = JSON.parse(String(patch?.[field]));
      return JSON.parse(
        new TextDecoder().decode(
          await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: Uint8Array.from(atob(envelope.$personal.iv), (c) => c.charCodeAt(0)),
            },
            key.cryptoKey,
            Uint8Array.from(atob(envelope.$personal.data), (c) => c.charCodeAt(0)),
          ),
        ),
      );
    };
    expect(await opened("born")).toBe("1990-01-02T00:00:00.000Z");
    expect(await opened("tags")).toEqual(["a"]);
    expect(await opened("email")).toBe("a@x");
  });

  it("keeps text that is no JSON as it is in a JSON field, and seals a non-string value as its JSON", async () => {
    const { keys } = keysOf();
    const patch = await settledPatch({
      context: contextOf(keys),
      stored: { customerId: "ana", email: 7, tags: "not json", phone: "555", phone__key: "k" },
    });
    expect(String(patch?.tags)).toMatch(/^\{"\$personal":/);
    expect(patch?.email__index).toBe('email="7"');
  });

  it("fills the key field of a sealed value from its envelope, marked when a forgetting kept the key, and its blind index when its key opens it", async () => {
    const { keys, keyOf } = keysOf(["bo"], ["cy"]);
    const ana = await keyOf("ana");
    const bo = await keyOf("bo");
    const cy = await keyOf("cy");
    const settle = async (person: string, key: PersonalKey) =>
      settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: person,
          email: await sealedFor(key, person, `${person}@x`),
          phone: "1",
          phone__key: "k",
        },
      });
    expect(await settle("ana", ana)).toEqual({
      email__key: ana.fingerprint,
      email__index: 'email="ana@x"',
    });
    expect(await settle("bo", bo)).toEqual({
      email__key: `retained:${bo.fingerprint}`,
      email__index: 'email="bo@x"',
    });
    expect(await settle("cy", cy)).toEqual({ email__key: cy.fingerprint });
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "ana",
          email: await sealedFor(ana, "ana", "a@x"),
          email__key: ana.fingerprint,
          email__index: "set",
          phone: "1",
          phone__key: "k",
        },
      }),
    ).toBeNull();
  });

  it("opens an envelope in a field now kept in the clear, a date as a date, and leaves one whose key is gone in a field that needs a value", async () => {
    const { keys, keyOf } = keysOf([], ["cy"]);
    const ana = await keyOf("ana");
    const cy = await keyOf("cy");
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "ana",
          joined: await sealedFor(ana, "ana", "2026-01-01T00:00:00.000Z"),
          phone: await sealedFor(ana, "ana", "555"),
          email: await sealedFor(ana, "ana", "a@x"),
          email__key: ana.fingerprint,
          email__index: "set",
        },
      }),
    ).toEqual({
      joined: new Date("2026-01-01T00:00:00.000Z"),
      joined__key: ana.fingerprint,
      phone: "555",
      phone__key: ana.fingerprint,
    });
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "cy",
          joined: await sealedFor(cy, "cy", "2026-01-01T00:00:00.000Z"),
          phone: await sealedFor(cy, "cy", "555"),
          email: await sealedFor(cy, "cy", "c@x"),
          email__key: cy.fingerprint,
        },
      }),
    ).toEqual({ joined: null, joined__key: cy.fingerprint, phone__key: cy.fingerprint });
  });

  it("gives a value in the clear of a field kept in the clear the key of its person, marked when a forgetting kept it", async () => {
    const { keys, keyOf } = keysOf(["bo"]);
    const bo = await keyOf("bo");
    const ana = await keyOf("ana");
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "bo",
          phone: "555",
          email: await sealedFor(bo, "bo", "b@x"),
          email__key: `retained:${bo.fingerprint}`,
          email__index: "set",
        },
      }),
    ).toEqual({ phone__key: `retained:${bo.fingerprint}` });
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "ana",
          phone: "555",
          phone__key: null,
          email: await sealedFor(ana, "ana", "a@x"),
          email__key: ana.fingerprint,
          email__index: "set",
        },
      }),
    ).toEqual({ phone__key: ana.fingerprint });
  });
});

describe("settling a table", () => {
  const setUp = async (rows: number) => {
    const { keys } = keysOf();
    const storage = await memory().createReadModel<Record<string, unknown>>({
      name: "customers",
      fields: layout.stored,
      logger: silentLogger,
    });
    for (let index = 0; index < rows; index += 1) {
      const id = `c-${String(index).padStart(3, "0")}`;
      await storage.table.upsert({ customerId: id, email: `${id}@x`, phone: "1", phone__key: "k" });
    }
    return { storage, context: contextOf(keys) };
  };

  it("settles page after page in primary key order, each row by its key alone", async () => {
    const { storage, context } = await setUp(101);
    const first = await settlePage({ context, table: storage.table, after: undefined });
    expect(first).toEqual({ last: "c-099", done: false });
    const stored = await storage.table.findMany({
      orderBy: { field: "customerId", direction: "asc" },
    });
    expect(stored.filter((row) => String(row.email).startsWith('{"$personal"'))).toHaveLength(100);
    expect(stored.at(-1)?.email).toBe("c-100@x");
    expect(await settlePage({ context, table: storage.table, after: first.last })).toEqual({
      last: "c-100",
      done: true,
    });
    expect(
      (await storage.table.findMany()).every((row) => String(row.email).startsWith('{"$personal"')),
    ).toBe(true);
    expect(await settlePage({ context, table: storage.table, after: "c-100" })).toEqual({
      last: undefined,
      done: true,
    });
  });

  it("seals what a write around the runtime left, past one batch, each row by its key alone", async () => {
    const { storage, context } = await setUp(101);
    await storage.transact({
      subscriber: "projection:customers",
      wait: true,
      work: (transaction) => settleUnsettled({ context, transaction }),
    });
    const stored = await storage.table.findMany();
    expect(stored).toHaveLength(101);
    expect(stored.every((row) => String(row.email).startsWith('{"$personal"'))).toBe(true);
    expect(new Set(stored.map((row) => row.email)).size).toBe(101);
  });
});

describe("settleReadModels", () => {
  it("settles a read model once for a layout, waiting for the lock it could not take, and leaves one without personal fields alone", async () => {
    const { keys, keyOf } = keysOf();
    const storage = await memory().createReadModel<Record<string, unknown>>({
      name: "customers",
      fields: layout.stored,
      logger: silentLogger,
    });
    await storage.table.upsert({ customerId: "ana", email: "a@x", phone: "1", phone__key: "k" });
    let refusals = 1;
    const busy = {
      ...storage,
      transact: (async (args) => {
        if (refusals > 0) {
          refusals -= 1;
          return { acquired: false };
        }
        return storage.transact(args);
      }) as typeof storage.transact,
    };
    const logged: string[] = [];
    const fieldsLogged: unknown[] = [];
    const logger = {
      ...silentLogger,
      info: (message: string, fields?: unknown) => {
        logged.push(message);
        fieldsLogged.push(fields);
      },
    };
    const ana = await keyOf("ana");
    const sealing = {
      keys: eachPerson(async (person: string) =>
        person === "ana" ? [{ category: "default", key: ana, retainedSince: null }] : [],
      ),
      indexer,
    };
    const plain = sealedLayoutOf({ readModel: "plans", fields: { plan: f.string().primaryKey() } });
    await settleReadModels({
      readModels: [
        { name: "customers", layout, storage: busy },
        { name: "plans", layout: plain, storage },
      ],
      sealing,
      logger,
    });
    expect(logged).toEqual(["read model settled"]);
    expect(fieldsLogged).toEqual([{ readModel: "customers" }]);
    const [row] = await storage.table.findMany();
    expect(String(row?.email)).toMatch(/^\{"\$personal":/);
    expect(row?.email__index).toBe('email="a@x"');
    expect(await storage.checkpointStore.get(settledMark("customers"))).toBe(
      layoutDigest({ layout }),
    );
    await settleReadModels({
      readModels: [{ name: "customers", layout, storage }],
      sealing,
      logger,
    });
    expect(logged).toEqual(["read model settled"]);
    void keys;
  });

  it("opens the index key only for a read model with a blind index", async () => {
    const store = (await memory().createStorage()).indexKeys;
    const wrapping = {
      wrapper: null,
      generate: () => Promise.reject(new Error("not asked")),
      unwrap: () => Promise.reject(new Error("not asked")),
      wrapped: () => Promise.reject(new Error("not asked")),
    };
    const unindexed = sealedLayoutOf({
      readModel: "notes",
      fields: { id: f.string().primaryKey().person(), note: f.string().personal() },
    });
    expect(
      (
        await openReadModelSealing({
          layouts: [unindexed],
          keys: eachPerson(() => []),
          indexKeys: store,
          wrapping,
          clock: { now: () => new Date(), after: () => () => undefined } as never,
          scheduler: { get: () => Promise.reject(new Error("not asked")) },
        })
      ).indexer,
    ).toBeNull();
  });
});

describe("layoutDigest", () => {
  it("tells layouts apart by their personal fields, and is never 0", () => {
    const other = sealedLayoutOf({
      readModel: "customers",
      fields: { ...fields, email: f.string().personal() },
    });
    expect(layoutDigest({ layout })).not.toBe(layoutDigest({ layout: other }));
    expect(layoutDigest({ layout })).toBeGreaterThan(0);
    expect(layoutDigest({ layout })).toBe(
      layoutDigest({ layout: sealedLayoutOf({ readModel: "customers", fields }) }),
    );
    expect(settledMark("customers")).toBe("read-model:settled:customers");
  });
});

describe("settling at its edges", () => {
  it("seals a value of no one under an empty person, and gives a field without a blind index none", async () => {
    const { keys } = keysOf();
    const patch = await settledPatch({
      context: contextOf(keys),
      stored: { born: "1990-01-02T00:00:00.000Z", phone: "1", phone__key: "k" },
    });
    expect(Object.keys(patch ?? {}).sort()).toEqual(["born", "born__key"]);
    expect(parseEnvelope(patch?.born)?.$personal.person).toBe("");
  });

  it("fills a missing key field and leaves a blind index that is there, and fills none for a field without one", async () => {
    const { keys, keyOf } = keysOf();
    const ana = await keyOf("ana");
    expect(
      await settledPatch({
        context: contextOf(keys),
        stored: {
          customerId: "ana",
          email: await sealedFor(ana, "ana", "a@x"),
          email__index: "set",
          born: await sealedFor(ana, "ana", "1990-01-02T00:00:00.000Z"),
          phone: "1",
          phone__key: "k",
        },
      }),
    ).toEqual({ email__key: ana.fingerprint, born__key: ana.fingerprint });
  });

  it("seals a value in the clear that has its key field, and keys a value in the clear of a field kept in the clear", async () => {
    const { storage, context } = await (async () => {
      const { keys } = keysOf();
      const created = await memory().createReadModel<Record<string, unknown>>({
        name: "customers",
        fields: layout.stored,
        logger: silentLogger,
      });
      return { storage: created, context: contextOf(keys) };
    })();
    await storage.table.upsert({
      customerId: "ana",
      email: "a@x",
      email__key: "k",
      phone: "1",
      phone__key: "k",
    });
    await storage.table.upsert({
      customerId: "bo",
      email: JSON.stringify({ $personal: { person: "bo", key: "k", iv: "i", data: "d" } }),
      email__key: "k",
      phone: "2",
    });
    await storage.transact({
      subscriber: "projection:customers",
      wait: true,
      work: (transaction) => settleUnsettled({ context, transaction }),
    });
    const [ana, bo] = await storage.table.findMany({
      orderBy: { field: "customerId", direction: "asc" },
    });
    expect(String(ana?.email)).toMatch(/^\{"\$personal":/);
    expect(bo?.phone__key).toEqual(expect.any(String));
  });

  it("goes through rows already settled without writing them again", async () => {
    const { keys } = keysOf();
    const storage = await memory().createReadModel<Record<string, unknown>>({
      name: "customers",
      fields: layout.stored,
      logger: silentLogger,
    });
    await storage.table.upsert({ customerId: "ana", email: "a@x", phone: "1", phone__key: "k" });
    const context = contextOf(keys);
    await settlePage({ context, table: storage.table, after: undefined });
    const writes: unknown[] = [];
    const counting = {
      ...storage.table,
      update: (where: never, patch: never) => {
        writes.push(where);
        return storage.table.update(where, patch);
      },
    };
    expect(await settlePage({ context, table: counting, after: undefined })).toEqual({
      last: "ana",
      done: true,
    });
    expect(writes).toEqual([]);
  });
});
