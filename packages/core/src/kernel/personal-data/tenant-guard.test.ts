import { describe, expect, it } from "vitest";
import { TenantForgottenError } from "../../contracts/errors.ts";
import { guardClient } from "./tenant-guard.ts";

const forgotten = new TenantForgottenError("acme", "2026-01-01T00:00:00.000Z");

const setUp = (live: () => Promise<void> = async () => undefined) => {
  const calls: string[] = [];
  const guarded = guardClient({
    ensureLive: async () => {
      calls.push("check");
      await live();
    },
    onForgotten: () => void calls.push("forgotten"),
  });
  return { calls, guarded };
};

describe("guardClient", () => {
  it("checks the tenant before every call, at any depth, and passes what is no object as it is", async () => {
    const { calls, guarded } = setUp();
    const client = guarded({
      name: "client",
      none: null,
      nothing: undefined,
      nested: { read: async (value: number) => value * 2 },
      sync: (value: number) => value + 1,
    });
    expect(client.name).toBe("client");
    expect(client.none).toBeNull();
    expect(client.nothing).toBeUndefined();
    expect(await client.nested.read(2)).toBe(4);
    expect(await client.sync(1)).toBe(2);
    expect(calls).toEqual(["check", "check"]);
    expect(guarded(3)).toBe(3);
    expect(guarded(null)).toBeNull();
  });

  it("leaves a thenable's then alone, so awaiting a guarded object gives it back", async () => {
    const { guarded } = setUp();
    const then = (resolve: (value: string) => void) => resolve("resolved");
    expect(guarded({ then }).then).toBe(then);
    const plain = guarded({ value: 1 });
    expect(await Promise.resolve(plain)).toBe(plain);
  });

  it("calls nothing once the tenant is known to be forgotten", async () => {
    const { calls, guarded } = setUp(async () => {
      throw forgotten;
    });
    let ran = false;
    const client = guarded({
      run: async () => {
        ran = true;
      },
    });
    await expect(client.run()).rejects.toBe(forgotten);
    expect(ran).toBe(false);
    expect(calls).toEqual(["check"]);
  });

  it("reports a forgetting a call runs into, and nothing for any other error", async () => {
    const { calls, guarded } = setUp();
    const failure = new Error("down");
    const client = guarded({
      forgotten: async () => {
        throw forgotten;
      },
      failing: async () => {
        throw failure;
      },
    });
    await expect(client.forgotten()).rejects.toBe(forgotten);
    await expect(client.failing()).rejects.toBe(failure);
    expect(calls).toEqual(["check", "forgotten", "check"]);
  });
});
