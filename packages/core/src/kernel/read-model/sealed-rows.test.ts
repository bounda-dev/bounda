import { describe, expect, it } from "vitest";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import { openRow, parseEnvelope, sealedLayoutOf, sealedValues } from "./sealed-rows.ts";
import type { SealingKeys } from "./sealing-keys.ts";

const fields: FieldsRecord = {
  id: f.string().primaryKey(),
  customerId: f.string().optional().person(),
  email: f.string().personal(),
  born: f.date().optional().personal(),
  phone: f.string().personal({ clear: true }),
  nickname: f.string().optional().personal({ clear: true }),
};

const keysOf = (retained: readonly string[] = []) => {
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
  const keys: SealingKeys = {
    forWrite: (person) => (person === null ? createDisposableKey() : keyOf(person)),
    forOpen: async (person, fingerprint) => {
      const key = await keyOf(person);
      return key.fingerprint === fingerprint ? key : null;
    },
    kept: async (person) => retained.includes(person),
    categoryOf: async (person, fingerprint) =>
      (await keyOf(person)).fingerprint === fingerprint ? "default" : null,
  };
  return { keys, keyOf };
};

const layout = sealedLayoutOf({ readModel: "customers", fields });

describe("sealedLayoutOf", () => {
  it("names the person field, the personal fields, whether one is kept in the clear and whether one has a blind index", () => {
    expect(layout).toMatchObject({ person: "customerId", clear: true, indexed: false });
    expect(layout.personal.map(({ field }) => field)).toEqual([
      "email",
      "born",
      "phone",
      "nickname",
    ]);
    const sealedOnly = sealedLayoutOf({
      readModel: "notes",
      fields: { id: f.string().primaryKey(), note: f.string().personal().index() },
    });
    expect(sealedOnly).toMatchObject({ person: null, clear: false, indexed: true });
  });
});

describe("sealedValues and openRow", () => {
  it("seals a whole row, a blank required field as null with its key, a blank optional one as nothing, and opens it back typed", async () => {
    const { keys, keyOf } = keysOf();
    const context = { layout, keys, indexer: null, event: () => null };
    const stored = await sealedValues({
      context,
      values: { id: "r-1", customerId: "ana", email: null, phone: "555" },
      person: "ana",
      whole: true,
    });
    const key = await keyOf("ana");
    expect(stored).toMatchObject({
      email__key: key.fingerprint,
      born: null,
      born__key: null,
      phone: "555",
      phone__key: key.fingerprint,
      nickname__key: null,
    });
    expect(parseEnvelope(stored.email)?.$personal.person).toBe("ana");
    expect((await openRow({ context, stored, hideRetained: false })).row).toEqual({
      id: "r-1",
      customerId: "ana",
      email: null,
      born: null,
      phone: "555",
      nickname: undefined,
    });
    const born = new Date("1990-01-02T00:00:00.000Z");
    const dated = await sealedValues({
      context,
      values: { born },
      person: "ana",
      whole: false,
    });
    expect(Object.keys(dated)).toEqual(["born", "born__key"]);
    expect((await openRow({ context, stored: dated, hideRetained: false })).row).toEqual({ born });
  });

  it("leaves out of a patch the fields it does not change, and refuses a value of no person", async () => {
    const { keys } = keysOf();
    const context = { layout, keys, indexer: null, event: () => null };
    expect(
      await sealedValues({
        context,
        values: { phone: undefined, id: "r" },
        person: "ana",
        whole: false,
      }),
    ).toEqual({ phone: undefined, id: "r" });
    await expect(
      sealedValues({ context, values: { phone: "1" }, person: null, whole: false }),
    ).rejects.toThrow(
      'a row writes "phone", marked .personal(), without naming its person in "customerId"',
    );
    const blank = await sealedValues({
      context,
      values: { id: "r", email: null, phone: null },
      person: null,
      whole: false,
    });
    expect(parseEnvelope(blank.email)?.$personal.person).toBe("");
    expect(blank.phone__key).toBeNull();
  });

  it("notes the persons a row names and the fields under a key a forgetting kept, leaving those unopened when asked", async () => {
    const { keys, keyOf } = keysOf(["bo"]);
    const context = { layout, keys, indexer: null, event: () => null };
    const stored = await sealedValues({
      context,
      values: { id: "r", customerId: "bo", email: "b@x", phone: "1" },
      person: "bo",
      whole: true,
    });
    const bo = await keyOf("bo");
    expect(stored.phone__key).toBe(`retained:${bo.fingerprint}`);
    const shown = await openRow({ context, stored, hideRetained: false });
    expect(shown).toMatchObject({
      persons: ["bo"],
      retained: true,
      retainedFields: ["email", "phone"],
    });
    expect(shown.row.email).toBe("b@x");
    const hidden = await openRow({ context, stored, hideRetained: true });
    expect(hidden.row.email).toBeNull();
    expect(hidden.row.phone).toBe("1");
    const unmarked = await openRow({
      context,
      stored: { id: "r", customerId: "ana", phone: "1", phone__key: "k" },
      hideRetained: true,
    });
    expect(unmarked).toEqual({
      row: { id: "r", customerId: "ana", phone: "1" },
      persons: ["ana"],
      retained: false,
      retainedFields: [],
    });
    const withoutPerson = await openRow({
      context,
      stored: { id: "r", email: stored.email },
      hideRetained: false,
    });
    expect(withoutPerson.persons).toEqual(["bo"]);
  });

  it("reads a date that is no string as it is, and a value that is no envelope or not JSON as null", async () => {
    const { keys } = keysOf();
    const context = { layout, keys, indexer: null, event: () => null };
    expect(parseEnvelope("{")).toBeNull();
    expect(parseEnvelope('{"a":1}')).toBeNull();
    expect(parseEnvelope(3)).toBeNull();
    expect(
      (await openRow({ context, stored: { id: "r", email: "{", born: null }, hideRetained: false }))
        .row,
    ).toEqual({ id: "r", email: null, born: null });
  });
});
