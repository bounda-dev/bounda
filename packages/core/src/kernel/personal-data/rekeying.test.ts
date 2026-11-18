import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY as D } from "../../adapter/storage/personal-key-store.ts";
import { memory } from "../../memory/index.ts";
import { keysOver, newStoredKey } from "../test-support.ts";
import { sealedKeys } from "./commands.ts";
import { seal, unseal } from "./crypto.ts";
import { openTextWith, sealUnderAll } from "./errors.ts";
import { createRekeying } from "./rekeying.ts";

const AT = "2026-03-01T00:00:00.000Z";

const setUp = async () => {
  const keys = keysOver((await memory().createStorage()).personalKeys);
  const replaced = async (person: string, category = D) => {
    const old = await keys.add(person, category, await newStoredKey());
    const fresh = await newStoredKey();
    expect(await keys.supersede(person, old, { ...fresh, at: AT })).toBe(true);
    return { old: await keys.open(person, old), fresh: await keys.open(person, fresh) };
  };
  const open = (value: Parameters<ReturnType<typeof openTextWith>>[0]) =>
    openTextWith(sealedKeys(keys))(value);
  return { keys, replaced, open, rekeying: createRekeying(keys) };
};

describe("createRekeying", () => {
  it("seals again under the key in its place what a superseded key sealed, and leaves alone what the key in force sealed", async () => {
    const { keys, replaced, rekeying } = await setUp();
    const { old, fresh } = await replaced("ana");
    const before = await seal({ key: old, person: "ana", category: D, value: "ana@x" });
    const after = await rekeying.sealed(before);
    expect(after.$personal).toMatchObject({ person: "ana", key: fresh.fingerprint });
    expect(await unseal({ key: fresh, sealed: after })).toBe("ana@x");
    expect(await rekeying.sealed(after)).toBe(after);
    const invoice = await keys.create("ana", "invoices");
    const current = await seal({ key: invoice, person: "ana", category: "invoices", value: 1 });
    expect(await rekeying.sealed(current)).toBe(current);
    expect((await rekeying.sealed(current)).$personal.category).toBe("invoices");
  });

  it("seals again each layer of a text sealed under several persons, the inner under the key in place of its own", async () => {
    const { keys, replaced, open, rekeying } = await setUp();
    const { old } = await replaced("ana");
    const bob = await keys.create("bob", D);
    const layered = await sealUnderAll(
      [{ category: D, key: bob, retainedSince: null }],
      "bob",
      await sealUnderAll([{ category: D, key: old, retainedSince: null }], "ana", "ana wrote"),
    );
    const after = await rekeying.text(layered);
    expect(after).not.toBe(layered);
    expect(after.$personal).toMatchObject({ person: "bob", key: bob.fingerprint });
    expect(await open(after)).toBe("ana wrote");
    expect(JSON.stringify(after)).not.toContain(old.fingerprint);
    expect(await rekeying.text("in the clear")).toBe("in the clear");
  });

  it("turns into null, under a key no one keeps, what a key no store keeps sealed, and a layer of it", async () => {
    const { keys, replaced, open, rekeying } = await setUp();
    const { fresh } = await replaced("ana");
    const gone = await seal({ key: fresh, person: "ana", category: D, value: "ana@x" });
    await keys.remove("ana", fresh.fingerprint);
    const scrubbed = await rekeying.sealed(gone);
    expect(scrubbed.$personal).toMatchObject({ person: "ana" });
    expect(scrubbed.$personal.key).not.toBe(fresh.fingerprint);
    expect(await open(scrubbed)).toBeNull();
    const bob = await keys.create("bob", D);
    const layered = await sealUnderAll(
      [{ category: D, key: bob, retainedSince: null }],
      "bob",
      gone,
    );
    const outer = await rekeying.sealed(layered);
    expect(outer.$personal.key).toBe(bob.fingerprint);
    expect(await open(outer)).toBeNull();
  });

  it("rewrites the sealed fields of a payload, of its state and of a list, keeping the rest as it is", async () => {
    const { replaced, rekeying } = await setUp();
    const { old, fresh } = await replaced("ana");
    const sealed = (value: unknown) => seal({ key: old, person: "ana", category: D, value });
    const payload = {
      email: await sealed("ana@x"),
      plan: "pro",
      state: { contact: await sealed("ana@x"), step: 2 },
      values: [await sealed("old"), "kept"],
    };
    const after = await rekeying.payload(payload);
    expect(after).toMatchObject({ plan: "pro", state: { step: 2 }, values: [{}, "kept"] });
    expect(JSON.stringify(after)).not.toContain(old.fingerprint);
    expect(JSON.stringify(after)).toContain(fresh.fingerprint);
    expect(await rekeying.payload(after)).toBe(after);
    expect(await rekeying.payload("not a record")).toBe("not a record");
    expect(rekeying.named(payload).map(([person]) => person)).toEqual(["ana", "ana", "ana"]);
    // Only `state` is read inside: a value nested in another record is not a field of the payload.
    expect(rekeying.named({ address: { email: await sealed("ana@x") }, state: "done" })).toEqual(
      [],
    );
  });

  it("turns into null what a superseded key sealed once the key in its place is gone too", async () => {
    const { keys, replaced, rekeying } = await setUp();
    const { old, fresh } = await replaced("ana");
    const before = await seal({ key: old, person: "ana", category: D, value: "ana@x" });
    const opened = keys.opened.bind(keys);
    vi.spyOn(keys, "opened").mockImplementation(async (person, fingerprint) =>
      fingerprint === fresh.fingerprint ? null : opened(person, fingerprint),
    );
    const after = await rekeying.sealed(before);
    expect(after.$personal.person).toBe("ana");
    expect([old.fingerprint, fresh.fingerprint]).not.toContain(after.$personal.key);
  });

  it("names each person under the key in place of the one a record named them under", async () => {
    const { replaced, rekeying } = await setUp();
    const { old, fresh } = await replaced("ana");
    const persons = [
      { person: "ana", fingerprint: old.fingerprint, retained: true as const },
      { person: "bob", fingerprint: null },
    ];
    expect(await rekeying.persons(persons)).toEqual([
      { person: "ana", fingerprint: fresh.fingerprint, retained: true },
      { person: "bob", fingerprint: null },
    ]);
    const current = [{ person: "ana", fingerprint: fresh.fingerprint }];
    expect(await rekeying.persons(current)).toBe(current);
  });
});

describe("createRekeying, what it names and reads", () => {
  it("names the key of a value sealed whole, none of text in the clear", async () => {
    const { sealed, rekeying } = await setUpNamed();
    expect(rekeying.named(sealed)).toEqual([["ana", sealed.$personal.key]]);
    expect(rekeying.named("in the clear")).toEqual([]);
  });

  it("reads no key for a person named in the clear, and keeps one named under a key now gone", async () => {
    const { keys, sealed, rekeying } = await setUpNamed();
    await keys.remove("ana", sealed.$personal.key);
    const opened = vi.spyOn(keys, "opened");
    const persons = [
      { person: "bob", fingerprint: null },
      { person: "ana", fingerprint: sealed.$personal.key },
    ];
    expect(await rekeying.persons(persons)).toBe(persons);
    expect(opened.mock.calls.map(([person]) => person)).toEqual(["ana"]);
  });
});

async function setUpNamed() {
  const keys = keysOver((await memory().createStorage()).personalKeys);
  const key = await keys.create("ana", D);
  const sealed = await seal({ key, person: "ana", category: D, value: "ana@x" });
  return { keys, sealed, rekeying: createRekeying(keys) };
}
