import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { fingerprintOf, generateWrappableKey } from "./crypto.ts";
import {
  buildKeyWrapper,
  cryptoKeyWrapperOver,
  defineKeyWrapper,
  isKeyWrapperDefinition,
  type KeyWrapper,
} from "./key-wrapper.ts";

const rawOf = async (key: CryptoKey): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey("raw", key));

// Hands back, and keeps, the very arrays it is given, as a careless wrapper would.
const carelessWrapper = () => {
  const given: Uint8Array[] = [];
  const returned: Uint8Array[] = [];
  const wrapper: KeyWrapper = {
    kid: "kid-1",
    wrap: async (key) => {
      given.push(key);
      return key;
    },
    unwrap: async ({ wrapped }) => {
      const key = Uint8Array.from(wrapped);
      returned.push(key);
      return key;
    },
  };
  return { wrapper, given, returned };
};

describe("cryptoKeyWrapperOver", () => {
  it("wraps a key's raw bytes with the app's wrapper and answers the key as one that cannot be exported", async () => {
    const { wrapper, given } = carelessWrapper();
    const over = cryptoKeyWrapperOver(wrapper);
    expect(over).toMatchObject({ kid: "kid-1", previous: [] });
    const key = await generateWrappableKey();
    const raw = await rawOf(key);
    const { wrapped, key: sealed } = await over.wrap(key);
    // A copy of what the wrapper answered: the array it was given is zeroed.
    expect(wrapped).toEqual(raw);
    expect(given).toHaveLength(1);
    expect(given[0]).toEqual(new Uint8Array(32));
    expect(sealed.extractable).toBe(false);
    expect(await fingerprintOf(sealed)).toBe(await fingerprintOf(key));
  });

  it("zeroes the raw bytes it gave a wrapper that fails", async () => {
    const given: Uint8Array[] = [];
    const over = cryptoKeyWrapperOver({
      kid: "kid-1",
      wrap: async (key) => {
        given.push(key);
        throw new Error("KMS unavailable");
      },
      unwrap: async () => new Uint8Array(32),
    });
    await expect(over.wrap(await generateWrappableKey())).rejects.toThrow("KMS unavailable");
    expect(given[0]).toEqual(new Uint8Array(32));
  });

  it("imports what the wrapper unwraps as the key asked for and zeroes the array it answered", async () => {
    const { wrapper, returned } = carelessWrapper();
    const over = cryptoKeyWrapperOver({ ...wrapper, previous: ["kid-0"] });
    expect(over.previous).toEqual(["kid-0"]);
    const key = await generateWrappableKey();
    const raw = await rawOf(key);
    const sealed = await over.unwrap({ kid: "kid-1", wrapped: raw, extractable: false });
    expect(sealed.extractable).toBe(false);
    expect(await fingerprintOf(sealed)).toBe(await fingerprintOf(key));
    const exportable = await over.unwrap({ kid: "kid-1", wrapped: raw, extractable: true });
    expect(await rawOf(exportable)).toEqual(raw);
    expect(returned).toHaveLength(2);
    for (const answered of returned) expect(answered).toEqual(new Uint8Array(32));
  });

  it("zeroes what the wrapper unwraps even when it is no key", async () => {
    const answered = Uint8Array.of(1, 2, 3);
    const over = cryptoKeyWrapperOver({
      kid: "kid-1",
      wrap: async (key) => key,
      unwrap: async () => answered,
    });
    await expect(
      over.unwrap({ kid: "kid-1", wrapped: new Uint8Array(40), extractable: false }),
    ).rejects.toThrow();
    expect(answered).toEqual(new Uint8Array(3));
  });
});

describe("defineKeyWrapper", () => {
  it("builds the app's wrapper from the environment when the app starts", async () => {
    const seen: unknown[] = [];
    const definition = defineKeyWrapper(async ({ env }) => {
      seen.push(env);
      return { ...carelessWrapper().wrapper, previous: ["kid-0"] };
    });
    expect(definition).toMatchObject({ kind: "bounda-key-wrapper" });
    const built = await buildKeyWrapper({ definition, env: { NAME: "value" } });
    expect(built).toMatchObject({ kid: "kid-1", previous: ["kid-0"] });
    expect(seen).toEqual([{ NAME: "value" }]);
  });

  it("fails the start with what create throws", async () => {
    const definition = defineKeyWrapper(() => {
      throw new Error("Set BOUNDA_KMS_KEY_ID");
    });
    await expect(buildKeyWrapper({ definition, env: {} })).rejects.toThrow("Set BOUNDA_KMS_KEY_ID");
  });
});

describe("buildKeyWrapper", () => {
  it("refuses anything masterKey or defineKeyWrapper did not build", async () => {
    await expect(
      buildKeyWrapper({ definition: { kind: "bounda-key-wrapper" }, env: {} }),
    ).rejects.toThrow(
      new ConfigurationError(
        'runtime.personalData.keyWrapper is not a key wrapper: build one with masterKey({ from: "BOUNDA_MASTER_KEY" }) or defineKeyWrapper',
      ),
    );
  });
});

describe("isKeyWrapperDefinition", () => {
  it("tells a key wrapper definition from anything else", () => {
    const definition = defineKeyWrapper(() => carelessWrapper().wrapper);
    expect(isKeyWrapperDefinition(definition)).toBe(true);
    const create: unknown = Reflect.get(definition, "create");
    for (const value of [
      null,
      undefined,
      "BOUNDA_MASTER_KEY",
      { create },
      { kind: "bounda-adapter", create },
      { kind: "bounda-key-wrapper", create: "not a function" },
      { kind: "bounda-key-wrapper" },
    ]) {
      expect(isKeyWrapperDefinition(value)).toBe(false);
    }
  });
});
