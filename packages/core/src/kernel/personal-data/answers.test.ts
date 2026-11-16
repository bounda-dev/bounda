import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY as D } from "../../adapter/storage/personal-key-store.ts";
import { testOutcome } from "../../adapter/testing/fixtures.ts";
import { memory } from "../../memory/index.ts";
import { keysOver, newStoredKey } from "../test-support.ts";
import { type AnswerSealing, openAnswer, type RememberedAnswer, sealAnswer } from "./answers.ts";
import { createAtRestSealer } from "./at-rest.ts";
import { isSealed } from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";

const answer: RememberedAnswer = {
  fingerprint: "fp",
  outcome: {
    rejected: "Taken",
    message: "ana@example.com is taken",
    aggregateType: "customer",
    aggregateId: "c-1",
  },
};

const marks: PersonalMarks = {
  person: null,
  fields: ["email", "iban"],
  categories: { email: D, iban: "billing" },
};

const setup = async () => {
  const keys = keysOver((await memory().createStorage()).personalKeys);
  const base = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const atRest = createAtRestSealer(base);
  const sealing = { keys, atRest };
  const sealed = (args: Partial<Parameters<typeof sealAnswer>[0]> = {}) =>
    sealAnswer({ ...sealing, answer, person: null, marks: null, payload: {}, read: [], ...args });
  const opened = (stored: object, by: AnswerSealing = sealing) =>
    openAnswer({ ...by, answer: stored });
  return { keys, atRest, sealed, opened };
};

describe("sealAnswer", () => {
  it("seals an answer that names nobody under the database's key, and one of an app without keys not at all", async () => {
    const { keys, sealed, opened } = await setup();
    const stored = await sealed();
    expect(stored.persons).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect(JSON.stringify(stored)).not.toContain('"fp"');
    expect(await opened(stored.answer ?? {})).toEqual(answer);
    expect(await opened(stored.answer ?? {}, { keys, atRest: null })).toBeNull();

    const clear = await sealAnswer({
      keys,
      atRest: null,
      answer,
      person: "c-1",
      marks,
      payload: { email: "ana@example.com" },
      read: [],
    });
    expect(clear).toEqual({ answer, persons: [] });
    expect(await keys.list("c-1")).toEqual([]);
    expect(await opened(clear.answer ?? {}, { keys, atRest: null })).toEqual(answer);
  });

  it("seals it under every key the command's person holds in force, one inside the other, and opens it only while each is", async () => {
    const { keys, sealed, opened } = await setup();
    const billing = await keys.add("c-1", "billing", await newStoredKey());
    const own = await keys.add("c-1", D, await newStoredKey());
    const kept = await keys.add("c-1", "invoices", await newStoredKey());
    await keys.retain("c-1", kept.fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    const stored = await sealed({ person: "c-1" });
    // The last key in sealing order seals outermost.
    expect(stored.answer).toMatchObject({ $personal: { person: "c-1", key: own.fingerprint } });
    expect(stored.persons).toEqual([
      { person: "c-1", fingerprint: billing.fingerprint },
      { person: "c-1", fingerprint: own.fingerprint },
    ]);
    expect(JSON.stringify(stored)).not.toContain("ana@example.com");
    expect(await opened(stored.answer ?? {})).toEqual(answer);
    await keys.remove("c-1", billing.fingerprint);
    expect(await opened(stored.answer ?? {})).toBeNull();
    expect((await keys.list("c-1")).map(({ category }) => category).sort()).toEqual([
      D,
      "invoices",
    ]);
  });

  it("gives the person a key of every category the payload holds a value of, and the default one when that leaves none", async () => {
    const { keys, sealed, opened } = await setup();
    const stored = await sealed({
      person: "c-1",
      marks,
      payload: { email: "ana@example.com", iban: null },
    });
    const [own] = await keys.list("c-1");
    expect(own?.category).toBe(D);
    expect(stored.persons).toEqual([{ person: "c-1", fingerprint: own?.key.fingerprint }]);
    expect(await opened(stored.answer ?? {})).toEqual(answer);

    const billed = await sealed({ person: "c-1", marks, payload: { iban: "ES00" } });
    const billing = await keys.get("c-1", "billing");
    expect(billed.persons).toEqual([
      { person: "c-1", fingerprint: billing?.fingerprint },
      { person: "c-1", fingerprint: own?.key.fingerprint },
    ]);
    expect(await keys.list("c-1")).toHaveLength(2);

    // A field the payload leaves out holds no value of its category.
    await sealed({ person: "c-3", marks, payload: { email: "bo@example.com" } });
    expect((await keys.list("c-3")).map(({ category }) => category)).toEqual([D]);
    // One who holds a key of another category in force gets no default key besides.
    const elsewhere = await keys.add("c-4", "billing", await newStoredKey());
    expect((await sealed({ person: "c-4" })).persons).toEqual([
      { person: "c-4", fingerprint: elsewhere.fingerprint },
    ]);
    expect(await keys.list("c-4")).toHaveLength(1);

    const bare = await sealed({ person: "c-2", marks: null });
    expect(bare.persons).toEqual([
      { person: "c-2", fingerprint: (await keys.get("c-2", D))?.fingerprint },
    ]);
    expect(isSealed(bare.answer)).toBe(true);
  });

  it("seals it under the keys of whoever the state was read of too", async () => {
    const { keys, sealed, opened } = await setup();
    const own = await keys.add("c-1", D, await newStoredKey());
    const other = await keys.add("c-2", D, await newStoredKey());
    const stored = await sealed({
      person: "c-1",
      read: [
        { person: "c-2", fingerprint: other.fingerprint },
        { person: "c-2", fingerprint: null },
      ],
    });
    expect(stored.persons).toEqual([
      { person: "c-1", fingerprint: own.fingerprint },
      { person: "c-2", fingerprint: other.fingerprint },
    ]);
    expect(await opened(stored.answer ?? {})).toEqual(answer);
    await keys.remove("c-2", other.fingerprint);
    expect(await opened(stored.answer ?? {})).toBeNull();

    const nobody = await sealed({ read: [{ person: "c-3", fingerprint: null }] });
    expect(nobody.persons).toEqual([
      { person: "c-3", fingerprint: (await keys.get("c-3", D))?.fingerprint },
    ]);
  });

  it("names everyone in order of their id, and gives the payload's categories to the command's person alone", async () => {
    const { keys, sealed } = await setup();
    const reader = await keys.add("a-1", D, await newStoredKey());
    const stored = await sealed({
      person: "c-1",
      marks,
      payload: { iban: "ES00" },
      read: [{ person: "a-1", fingerprint: reader.fingerprint }],
    });
    expect(stored.persons.map(({ person }) => person)).toEqual(["a-1", "c-1"]);
    expect(stored.answer).toMatchObject({ $personal: { person: "c-1" } });
    expect((await keys.list("a-1")).map(({ category }) => category)).toEqual([D]);
  });

  it("erases it at once when a key the state was read under is gone, or kept by a forgetting, read so or not", async () => {
    const { keys, sealed } = await setup();
    const own = await keys.add("c-1", D, await newStoredKey());
    expect(await sealed({ person: "c-1", read: [{ person: "c-1", fingerprint: "gone" }] })).toEqual(
      { answer: null, persons: [] },
    );
    await keys.retain("c-1", own.fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    for (const retained of [undefined, true] as const) {
      expect(
        await sealed({
          person: "c-1",
          read: [
            { person: "c-1", fingerprint: own.fingerprint, ...(retained ? { retained } : {}) },
          ],
        }),
      ).toEqual({ answer: null, persons: [] });
    }
  });
});

describe("openAnswer", () => {
  it("reads an answer kept before answers were sealed whole, its outcome in the clear or under the database's key", async () => {
    const { keys, atRest, opened } = await setup();
    const outcome = testOutcome("1");
    expect(await opened({ fingerprint: "fp", outcome })).toEqual({ fingerprint: "fp", outcome });
    const earlier = { fingerprint: "fp", outcome: await atRest.seal(JSON.stringify(outcome)) };
    expect(await opened(earlier)).toEqual({ fingerprint: "fp", outcome });
    expect(await opened(earlier, { keys, atRest: null })).toBeNull();
  });
});
