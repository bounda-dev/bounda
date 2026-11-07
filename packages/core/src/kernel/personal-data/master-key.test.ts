import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { KeyWrapper } from "./key-wrapper.ts";
import { GENERATE_MASTER_KEY_COMMAND, masterKey } from "./master-key.ts";

const randomKey = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

const raw = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

const create = (
  env: Record<string, string | undefined>,
  previous?: readonly string[],
): Promise<KeyWrapper> =>
  Promise.resolve(
    masterKey({
      from: "BOUNDA_MASTER_KEY",
      ...(previous === undefined ? {} : { previous }),
    }).create({
      env,
    }),
  );

const failure = async (promise: Promise<unknown>): Promise<ConfigurationError> => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConfigurationError);
  return error as ConfigurationError;
};

describe("masterKey", () => {
  it("is a key wrapper definition", () => {
    expect(masterKey({ from: "BOUNDA_MASTER_KEY" }).kind).toBe("bounda-key-wrapper");
  });

  it("wraps a key into bytes that are not the key, and unwraps them back", async () => {
    const wrapper = await create({ BOUNDA_MASTER_KEY: randomKey() });
    const key = raw();
    const wrapped = await wrapper.wrap(key);
    expect(wrapped).toHaveLength(40);
    expect(Buffer.from(wrapped).includes(Buffer.from(key))).toBe(false);
    expect(await wrapper.unwrap({ kid: wrapper.kid, wrapped })).toEqual(key);
  });

  it("names a key with an id derived from it, the same on every start and another for another key", async () => {
    const text = randomKey();
    const first = await create({ BOUNDA_MASTER_KEY: text });
    const again = await create({ BOUNDA_MASTER_KEY: ` ${text}\n` });
    const other = await create({ BOUNDA_MASTER_KEY: randomKey() });
    expect(first.kid).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(again.kid).toBe(first.kid);
    expect(other.kid).not.toBe(first.kid);
    expect(first.previous).toEqual([]);
  });

  it("spells the id in base64url: the first 12 bytes of the key's SHA-256", async () => {
    // Its digest starts with bytes whose base64 holds both "+" and "/".
    const wrapper = await create({
      BOUNDA_MASTER_KEY: "zzLkCfES5X/PVVpxp0H5s/CfMor8FMJPVRxTfMx36SA=",
    });
    expect(wrapper.kid).toBe("ub3KXcM1-cw4NhM_");
  });

  it("unwraps under the previous keys what they wrapped, and wraps only under the current one", async () => {
    const old = randomKey();
    const before = await create({ BOUNDA_MASTER_KEY: old });
    const key = raw();
    const wrapped = await before.wrap(key);
    const after = await create({ BOUNDA_MASTER_KEY: randomKey(), BOUNDA_MASTER_KEY_OLD: old }, [
      "BOUNDA_MASTER_KEY_OLD",
    ]);
    expect(after.previous).toEqual([before.kid]);
    expect(await after.unwrap({ kid: before.kid, wrapped })).toEqual(key);
    expect(await after.unwrap({ kid: after.kid, wrapped: await after.wrap(key) })).toEqual(key);
  });

  it("leaves out of the previous keys the current one and any named twice", async () => {
    const text = randomKey();
    const old = randomKey();
    const wrapper = await create(
      { BOUNDA_MASTER_KEY: text, SAME: text, OLD: old, OLD_AGAIN: old },
      ["SAME", "OLD", "OLD_AGAIN"],
    );
    expect(wrapper.previous).toEqual([(await create({ BOUNDA_MASTER_KEY: old })).kid]);
  });

  it("fails to start, naming the variable and how to generate a key, when a variable is missing", async () => {
    for (const env of [{}, { BOUNDA_MASTER_KEY: "" }, { BOUNDA_MASTER_KEY: "  " }]) {
      const error = await failure(create(env));
      expect(error.message).toContain("BOUNDA_MASTER_KEY");
      expect(error.message).toContain("is not set");
      expect(error.message).toContain(GENERATE_MASTER_KEY_COMMAND);
    }
    const previous = await failure(create({ BOUNDA_MASTER_KEY: randomKey() }, ["MISSING_KEY"]));
    expect(previous.message).toContain("MISSING_KEY");
  });

  it("fails to start, never quoting the value, when a variable holds anything but 32 bytes in base64", async () => {
    const values = [
      "not-a-key",
      Buffer.from(new Uint8Array(16)).toString("base64"),
      Buffer.from(new Uint8Array(33)).toString("base64"),
      `${randomKey().slice(0, 43)}!`,
      Buffer.from(new Uint8Array(32)).toString("base64url"),
    ];
    for (const value of values) {
      const error = await failure(create({ BOUNDA_MASTER_KEY: value }));
      expect(error.message).toContain("BOUNDA_MASTER_KEY does not hold a master key");
      expect(error.message).toContain(GENERATE_MASTER_KEY_COMMAND);
      expect(error.message).not.toContain(value);
    }
  });

  it("refuses an id it has no key for, and a wrapped key that was altered", async () => {
    const wrapper = await create({ BOUNDA_MASTER_KEY: randomKey() });
    const wrapped = await wrapper.wrap(raw());
    expect((await failure(wrapper.unwrap({ kid: "unknown", wrapped }))).message).toBe(
      "No master key configured has the id unknown",
    );
    const altered = Uint8Array.from(wrapped);
    altered[0] = (altered[0] ?? 0) ^ 1;
    const error = await failure(wrapper.unwrap({ kid: wrapper.kid, wrapped: altered }));
    expect(error.message).toContain(`does not unwrap under the master key ${wrapper.kid}`);
    expect(error.cause).toBeDefined();
  });

  it("refuses to unwrap under one master key what another wrapped", async () => {
    const first = await create({ BOUNDA_MASTER_KEY: randomKey() });
    const second = await create({ BOUNDA_MASTER_KEY: randomKey() });
    const wrapped = await first.wrap(raw());
    await failure(second.unwrap({ kid: second.kid, wrapped }));
  });
});
