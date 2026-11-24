import { describe, expect, it } from "vitest";
import { TenantFrozenError } from "../../contracts/errors.ts";
import { throughFreeze } from "./transact.ts";

const FROZEN = new TenantFrozenError("acme", "2026-03-01T00:00:00.000Z");

describe("throughFreeze", () => {
  it("answers what the freeze committed of a request its own commit was refused, and the refusal when nothing", async () => {
    const refused = async (): Promise<string> => {
      throw FROZEN;
    };
    expect(await throughFreeze({ work: refused, committed: async () => "landed" })).toBe("landed");
    await expect(throughFreeze({ work: refused, committed: async () => null })).rejects.toBe(
      FROZEN,
    );
  });

  it("throws any other error as it is, without looking for what landed", async () => {
    const outage = new Error("database down");
    let looked = false;
    await expect(
      throughFreeze({
        work: async () => {
          throw outage;
        },
        committed: async () => {
          looked = true;
          return "landed";
        },
      }),
    ).rejects.toBe(outage);
    expect(looked).toBe(false);
  });
});
