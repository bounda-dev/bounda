import { describe, expect, it } from "vitest";
import { generatePersonalKey, importPersonalKey, isSealed, seal, unseal } from "./crypto.ts";

describe("personal data crypto", () => {
  it("seals a value under a person and opens it with the same key, whatever its type", async () => {
    const key = await importPersonalKey(await generatePersonalKey());
    for (const value of ["ana@example.com", 42, true, null, { street: "Main 1" }, ["a", "b"]]) {
      const sealed = await seal({ key, person: "c-1", value });
      expect(isSealed(sealed)).toBe(true);
      expect(sealed.$personal.person).toBe("c-1");
      expect(sealed.$personal.key).toBe(key.id);
      expect(sealed.$personal.data).not.toContain(JSON.stringify(value));
      expect(await unseal({ key, sealed })).toEqual(value);
    }
  });

  it("gives every key and every sealing a different text", async () => {
    const keys = await Promise.all([generatePersonalKey(), generatePersonalKey()]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toHaveLength(44);
    const key = await importPersonalKey(keys[0] ?? "");
    const [first, second] = await Promise.all([
      seal({ key, person: "c-1", value: "same" }),
      seal({ key, person: "c-1", value: "same" }),
    ]);
    expect(first.$personal.iv).not.toBe(second.$personal.iv);
    expect(first.$personal.data).not.toBe(second.$personal.data);
  });

  it("imports a key that cannot be exported again, with a fingerprint of its own", async () => {
    const stored = await generatePersonalKey();
    const key = await importPersonalKey(stored);
    expect(key.cryptoKey.extractable).toBe(false);
    expect(key.cryptoKey.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect((await importPersonalKey(stored)).id).toBe(key.id);
    expect((await importPersonalKey(await generatePersonalKey())).id).not.toBe(key.id);
    expect(key.id).not.toBe(stored);
  });

  it("opens nothing without a key or with another one, and refuses a value its key should open", async () => {
    const [own, other] = await Promise.all([generatePersonalKey(), generatePersonalKey()]);
    const key = await importPersonalKey(own);
    const sealed = await seal({ key, person: "c-1", value: "ana@example.com" });
    expect(await unseal({ key: null, sealed })).toBeNull();
    expect(await unseal({ key: await importPersonalKey(other), sealed })).toBeNull();
    const forged = { $personal: { ...sealed.$personal, data: sealed.$personal.iv } };
    await expect(unseal({ key, sealed: forged })).rejects.toThrow();
  });

  it("takes for sealed only an object holding nothing but a complete envelope", () => {
    const envelope = { person: "c-1", key: "k", iv: "aQ==", data: "ZA==" };
    expect(isSealed({ $personal: envelope })).toBe(true);
    expect(isSealed({ $personal: envelope, more: 1 })).toBe(false);
    expect(isSealed({ $personal: { ...envelope, data: 1 } })).toBe(false);
    expect(isSealed({ $personal: { person: "c-1", iv: "aQ==" } })).toBe(false);
    expect(isSealed({ $personal: { ...envelope, person: 1 } })).toBe(false);
    expect(isSealed({ $personal: { ...envelope, iv: 1 } })).toBe(false);
    expect(isSealed({ $personal: { ...envelope, key: 1 } })).toBe(false);
    expect(isSealed({ $personal: null })).toBe(false);
    expect(isSealed({ personal: envelope })).toBe(false);
    expect(isSealed({ $personal: "text" })).toBe(false);
    expect(isSealed([{ $personal: envelope }])).toBe(false);
    expect(isSealed("ana@example.com")).toBe(false);
    expect(isSealed(null)).toBe(false);
  });
});
