import { describe, expect, it } from "vitest";
import type { TenantFence } from "../../adapter/storage/tenant-fence.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { boundForgetLedger } from "./forget-ledger.ts";

describe("a forget ledger bounded in time", () => {
  it("names the fence's read or set that did not answer in time", async () => {
    const clock = createFixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const never = new Promise<never>(() => undefined);
    const ledger = boundForgetLedger({
      ledger: {
        append: async () => undefined,
        read: async () => [],
        readMark: async () => [],
        raiseMark: async () => undefined,
        clear: async () => true,
        fence: { read: () => never, set: () => never },
      },
      timeoutMs: 1_000,
      clock,
    });
    const reading = ledger.fence.read();
    const setting = ledger.fence.set({ state: "open" });
    clock.advance(1_000);
    await expect(reading).rejects.toMatchObject({ operation: "fence.read", timeoutMs: 1_000 });
    await expect(setting).rejects.toMatchObject({ operation: "fence.set" });
  });

  it("tells the store the ledger it bounds tells, and none when it tells none", () => {
    const clock = createFixedClock(new Date("2026-03-01T00:00:00.000Z"));
    const ledger = {
      append: async () => undefined,
      read: async () => [],
      readMark: async () => [],
      raiseMark: async () => undefined,
      clear: async () => true,
      fence: {
        read: async () => ({ state: "open" as const }),
        set: async (fence: TenantFence) => fence,
      },
    };
    const store = {};
    expect(
      boundForgetLedger({ ledger: { ...ledger, storeId: store }, timeoutMs: 1_000, clock }).storeId,
    ).toBe(store);
    expect("storeId" in boundForgetLedger({ ledger, timeoutMs: 1_000, clock })).toBe(false);
  });
});
