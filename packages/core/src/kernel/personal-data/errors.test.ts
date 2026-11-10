import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { keysOver, newStoredKey } from "../test-support.ts";
import { sealedKeys } from "./commands.ts";
import { isSealed, unseal } from "./crypto.ts";
import { openTextWith, sealError, sealUnderAll } from "./errors.ts";

const setup = async () => {
  const keys = keysOver((await memory().createStorage()).personalKeys);
  const held = await keys.add("c-1", DEFAULT_PERSONAL_CATEGORY, await newStoredKey());
  return { keys, held, open: () => openTextWith(sealedKeys(keys)) };
};

describe("sealError", () => {
  it("keeps the text in the clear for work that names nobody", async () => {
    const { keys } = await setup();
    const error = new ValidationError("refused", []);
    expect(await sealError({ error, person: null, keys })).toEqual({
      errorName: "ValidationError",
      errorCode: "VALIDATION_FAILED",
      errorMessage: "refused",
      errorStack: error.stack,
    });
    expect(await sealError({ error: "boom", person: null, keys })).toEqual({
      errorName: "string",
      errorMessage: "boom",
    });
  });

  it("seals the message and the stack under the key the person holds, and opens them again", async () => {
    const { keys, held, open } = await setup();
    const error = new Error("cannot mail ana@example.com");
    const sealed = await sealError({ error, person: "c-1", keys });
    expect(sealed).toMatchObject({ errorName: "Error" });
    expect(isSealed(sealed.errorMessage)).toBe(true);
    expect(isSealed(sealed.errorStack)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("ana@example.com");
    expect(sealed.errorMessage).toMatchObject({
      $personal: { person: "c-1", key: held.fingerprint },
    });

    const stackless = await sealError({ error: "boom", person: "c-1", keys });
    expect(stackless).not.toHaveProperty("errorStack");
    expect(isSealed(stackless.errorMessage)).toBe(true);

    const opener = open();
    expect(await opener(sealed.errorMessage)).toBe("cannot mail ana@example.com");
    expect(await opener(sealed.errorStack ?? "")).toBe(error.stack);
    expect(await opener("in the clear")).toBe("in the clear");
  });

  it("reads null once the person is forgotten", async () => {
    const { keys, held, open } = await setup();
    const before = await sealError({ error: new Error("first"), person: "c-1", keys });
    await keys.remove("c-1", held.fingerprint);
    expect(await open()(before.errorMessage)).toBeNull();
    expect(await open()(before.errorStack ?? "")).toBeNull();
  });

  it("never gives a forgotten person a key, and seals what their work read unreadable", async () => {
    const { keys, held, open } = await setup();
    await keys.remove("c-1", held.fingerprint);
    const sealed = await sealError({ error: new Error("ana@example.com"), person: "c-1", keys });
    expect(await keys.list("c-1")).toEqual([]);
    expect(isSealed(sealed.errorMessage)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("ana@example.com");
    expect(await open()(sealed.errorMessage)).toBeNull();
  });

  it("seals the text under every key the person holds, one inside the other by category, opening only while they hold all", async () => {
    const { keys, held, open } = await setup();
    const invoices = await keys.add("c-1", "invoices", await newStoredKey());
    const profile = await keys.add("c-1", "profile", await newStoredKey());
    await keys.retain("c-1", invoices.fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2025-12-01T00:00:00.000Z",
    });
    const sealed = await sealError({ error: new Error("ana@example.com"), person: "c-1", keys });
    const layers: string[] = [];
    let layer: unknown = sealed.errorMessage;
    while (isSealed(layer)) {
      layers.push(layer.$personal.key);
      const key = await keys.opened("c-1", layer.$personal.key);
      layer = await unseal({ key, sealed: layer });
    }
    expect(layers).toEqual([profile.fingerprint, invoices.fingerprint, held.fingerprint]);
    expect(layer).toBe("ana@example.com");
    expect(await open()(sealed.errorMessage)).toBe("ana@example.com");
    expect(await open()(sealed.errorStack ?? "")).toContain("ana@example.com");
    await keys.remove("c-1", invoices.fingerprint);
    expect(await open()(sealed.errorMessage)).toBeNull();
    expect(await open()(sealed.errorStack ?? "")).toBeNull();
  });

  it("seals under a key no store keeps what the work read under a key the person no longer holds", async () => {
    const { keys, held, open } = await setup();
    const read = [
      { person: "c-1", fingerprint: "gone" },
      { person: "c-2", fingerprint: "other" },
    ];
    const sealed = await sealError({
      error: new Error("ana@example.com"),
      person: "c-1",
      keys,
      read,
    });
    expect(isSealed(sealed.errorMessage)).toBe(true);
    expect(sealed.errorMessage).not.toMatchObject({ $personal: { key: held.fingerprint } });
    expect(await open()(sealed.errorMessage)).toBeNull();
    const readHeld = [{ person: "c-1", fingerprint: held.fingerprint }];
    const kept = await sealError({ error: new Error("bo"), person: "c-1", keys, read: readHeld });
    expect(await open()(kept.errorMessage)).toBe("bo");
  });

  it("seals under a key no store keeps what the work read under a key a forgetting kept since", async () => {
    const { keys, held, open } = await setup();
    await keys.retain("c-1", held.fingerprint, {
      since: "2026-02-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    const readInForce = [{ person: "c-1", fingerprint: held.fingerprint }];
    const dropped = await sealError({
      error: new Error("ana@example.com"),
      person: "c-1",
      keys,
      read: readInForce,
    });
    expect(await open()(dropped.errorMessage)).toBeNull();
    const readKept = [{ person: "c-1", fingerprint: held.fingerprint, retained: true as const }];
    const kept = await sealError({ error: new Error("bo"), person: "c-1", keys, read: readKept });
    expect(await open()(kept.errorMessage)).toBe("bo");
  });
});

describe("sealUnderAll", () => {
  it("seals under each key in turn, the last one outermost", async () => {
    const { keys, held } = await setup();
    const other = await keys.add("c-1", "invoices", await newStoredKey());
    const under = await keys.heldAll("c-1");
    const sealed = await sealUnderAll(under, "c-1", "text");
    const last = under.at(-1);
    expect(sealed.$personal).toMatchObject({ person: "c-1", key: last?.key.fingerprint });
    expect(under.map(({ key }) => key.fingerprint).toSorted()).toEqual(
      [held.fingerprint, other.fingerprint].toSorted(),
    );
    const opened = await openTextWith(sealedKeys(keys))(sealed);
    expect(opened).toBe("text");
  });
});
