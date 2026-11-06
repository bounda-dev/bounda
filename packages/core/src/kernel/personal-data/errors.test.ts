import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import { memory } from "../../memory/index.ts";
import { sealedKeys } from "./commands.ts";
import { generatePersonalKey, isSealed } from "./crypto.ts";
import { openTextWith, sealError } from "./errors.ts";

const setup = async () => {
  const keys = (await memory().createStorage()).personalKeys;
  const held = await keys.add("c-1", await generatePersonalKey());
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
    const { keys, open } = await setup();
    const before = await sealError({ error: new Error("first"), person: "c-1", keys });
    await keys.remove("c-1");
    expect(await open()(before.errorMessage)).toBeNull();
    expect(await open()(before.errorStack ?? "")).toBeNull();
  });

  it("never gives a forgotten person a key, and seals what their work read unreadable", async () => {
    const { keys, open } = await setup();
    await keys.remove("c-1");
    const sealed = await sealError({ error: new Error("ana@example.com"), person: "c-1", keys });
    expect(await keys.get("c-1")).toBeNull();
    expect(isSealed(sealed.errorMessage)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("ana@example.com");
    expect(await open()(sealed.errorMessage)).toBeNull();
  });
});
