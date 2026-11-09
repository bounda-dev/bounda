import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import {
  categoryOf,
  createDisposableKey,
  fingerprintOf,
  generateWrappableKey,
  importRawKey,
  isSealed,
  seal,
  unseal,
  withRawKey,
} from "./crypto.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("personal data crypto", () => {
  it("seals a value under a person and opens it with the same key, whatever its type", async () => {
    const key = await createDisposableKey();
    for (const value of ["ana@example.com", 42, true, null, { street: "Main 1" }, ["a", "b"]]) {
      const sealed = await seal({ key, person: "c-1", category: DEFAULT_PERSONAL_CATEGORY, value });
      expect(isSealed(sealed)).toBe(true);
      expect(sealed.$personal.person).toBe("c-1");
      expect(sealed.$personal.key).toBe(key.fingerprint);
      expect(await unseal({ key, sealed })).toEqual(value);
    }
  });

  it("names the category in the envelope only when it is not the default one", async () => {
    const key = await createDisposableKey();
    const plain = await seal({ key, person: "c-1", category: DEFAULT_PERSONAL_CATEGORY, value: 1 });
    expect(plain.$personal).not.toHaveProperty("category");
    expect(categoryOf(plain)).toBe(DEFAULT_PERSONAL_CATEGORY);
    const invoices = await seal({ key, person: "c-1", category: "invoices", value: 1 });
    expect(invoices.$personal.category).toBe("invoices");
    expect(categoryOf(invoices)).toBe("invoices");
    expect(await unseal({ key, sealed: invoices })).toBe(1);
  });

  it("leaves no trace of the value in the sealed text", async () => {
    const key = await createDisposableKey();
    // Long enough that random base64 cannot spell them by chance, as it can `42` or `null`.
    for (const value of ["ana@example.com", { street: "Main Street 1" }]) {
      const sealed = await seal({ key, person: "c-1", category: DEFAULT_PERSONAL_CATEGORY, value });
      expect(sealed.$personal.data).not.toContain(JSON.stringify(value));
    }
  });

  it("gives every key and every sealing a different text", async () => {
    const [one, other] = await Promise.all([createDisposableKey(), createDisposableKey()]);
    expect(one.fingerprint).not.toBe(other.fingerprint);
    expect(one.fingerprint).toHaveLength(24);
    const [first, second] = await Promise.all([
      seal({ key: one, person: "c-1", category: DEFAULT_PERSONAL_CATEGORY, value: "same" }),
      seal({ key: one, person: "c-1", category: DEFAULT_PERSONAL_CATEGORY, value: "same" }),
    ]);
    expect(first.$personal.iv).not.toBe(second.$personal.iv);
    expect(first.$personal.data).not.toBe(second.$personal.data);
  });

  it("fingerprints a key with the AES-GCM tag of nothing under the all-zero nonce, exportable or not", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const usages: KeyUsage[] = ["encrypt", "decrypt"];
    const exportable = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, usages);
    const sealed = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
    const tag = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: new Uint8Array(12) },
        exportable,
        new Uint8Array(),
      ),
    );
    expect(tag).toHaveLength(16);
    expect(await fingerprintOf(sealed)).toBe(btoa(String.fromCharCode(...tag)));
    expect(await fingerprintOf(exportable)).toBe(await fingerprintOf(sealed));
  });

  it("never seals under the fingerprint's nonce: every nonce drawn has its top bit set", async () => {
    const key = await createDisposableKey();
    const firsts = new Set<number>();
    for (let sealing = 0; sealing < 64; sealing += 1) {
      const { $personal } = await seal({
        key,
        person: "c-1",
        category: DEFAULT_PERSONAL_CATEGORY,
        value: sealing,
      });
      const first = atob($personal.iv).charCodeAt(0);
      expect(first).toBeGreaterThanOrEqual(0x80);
      firsts.add(first);
    }
    // The other seven bits stay random.
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("creates disposable keys that cannot be exported, and wrappable ones that can", async () => {
    const disposable = await createDisposableKey();
    expect(disposable.cryptoKey.extractable).toBe(false);
    expect(disposable.cryptoKey.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect(disposable.cryptoKey.usages.toSorted()).toEqual(["decrypt", "encrypt"]);
    await expect(crypto.subtle.exportKey("raw", disposable.cryptoKey)).rejects.toThrow();
    expect(disposable.fingerprint).toBe(await fingerprintOf(disposable.cryptoKey));
    const wrappable = await generateWrappableKey();
    expect(wrappable.extractable).toBe(true);
    expect(wrappable.algorithm).toEqual({ name: "AES-GCM", length: 256 });
    expect(wrappable.usages.toSorted()).toEqual(["decrypt", "encrypt"]);
  });

  it("imports raw bytes as the key asked for and zeroes them, imported or not", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const copy = Uint8Array.from(raw);
    const key = await importRawKey({ raw, extractable: false });
    expect(raw).toEqual(new Uint8Array(32));
    expect(key.extractable).toBe(false);
    expect(key.usages.toSorted()).toEqual(["decrypt", "encrypt"]);
    const exportable = await importRawKey({ raw: Uint8Array.from(copy), extractable: true });
    expect(new Uint8Array(await crypto.subtle.exportKey("raw", exportable))).toEqual(copy);
    expect(await fingerprintOf(exportable)).toBe(await fingerprintOf(key));
    const short = Uint8Array.of(1, 2, 3);
    await expect(importRawKey({ raw: short, extractable: false })).rejects.toThrow();
    expect(short).toEqual(new Uint8Array(3));
  });

  it("zeroes the copy WebCrypto imports from too", async () => {
    const imported = vi.spyOn(crypto.subtle, "importKey");
    await importRawKey({ raw: crypto.getRandomValues(new Uint8Array(32)), extractable: false });
    const [, data] = imported.mock.calls[0] ?? [];
    expect(data).toEqual(new Uint8Array(32));
  });

  it("lends an exportable key's raw bytes for one call and zeroes them once it settles", async () => {
    const key = await generateWrappableKey();
    const expected = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    let lent = new Uint8Array();
    expect(
      await withRawKey(key, async (raw) => {
        lent = raw;
        expect(raw).toEqual(expected);
        return "used";
      }),
    ).toBe("used");
    expect(lent).toEqual(new Uint8Array(32));
    await expect(
      withRawKey(key, async (raw) => {
        lent = raw;
        throw new Error("wrapper down");
      }),
    ).rejects.toThrow("wrapper down");
    expect(lent).toEqual(new Uint8Array(32));
  });

  it("opens nothing without a key or with another one, and refuses a value its key should open", async () => {
    const [key, other] = await Promise.all([createDisposableKey(), createDisposableKey()]);
    const sealed = await seal({
      key,
      person: "c-1",
      category: DEFAULT_PERSONAL_CATEGORY,
      value: "ana@example.com",
    });
    expect(await unseal({ key: null, sealed })).toBeNull();
    expect(await unseal({ key: other, sealed })).toBeNull();
    const forged = { $personal: { ...sealed.$personal, data: sealed.$personal.iv } };
    await expect(unseal({ key, sealed: forged })).rejects.toThrow();
  });

  it("takes for sealed only an object holding nothing but a complete envelope", () => {
    const envelope = { person: "c-1", key: "k", iv: "aQ==", data: "ZA==" };
    expect(isSealed({ $personal: envelope })).toBe(true);
    expect(isSealed({ $personal: { ...envelope, category: "invoices" } })).toBe(true);
    expect(isSealed({ $personal: { ...envelope, category: 1 } })).toBe(false);
    expect(isSealed({ $personal: { ...envelope, category: null } })).toBe(false);
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
