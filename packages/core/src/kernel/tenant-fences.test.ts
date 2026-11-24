import { describe, expect, it } from "vitest";
import type { TenantFence, TenantFenceStore } from "../adapter/storage/tenant-fence.ts";
import { createFixedClock } from "../contracts/clock.ts";
import { TenantForgottenError, TenantFrozenError } from "../contracts/errors.ts";
import { TENANT_CHECK_INTERVAL_MS } from "./personal-data/forgotten-tenant.ts";
import {
  createFenceWatch,
  createFreezeKeeper,
  fenceAwareLogger,
  freezeStores,
  unfreezeStores,
  whollyFrozen,
} from "./tenant-fences.ts";
import { createRecordingLogger } from "./test-support.ts";

const AT = "2026-03-01T00:00:00.000Z";
const FROZEN: TenantFence = { state: "frozen", tenant: "acme", since: AT };
const FORGOTTEN: TenantFence = { state: "forgotten", tenant: "acme", since: AT };

// A fence that records what was asked of it under `name`, holding `held` until set.
const fenceOf = (name: string, calls: string[], held: TenantFence = { state: "open" }) => {
  let fence = held;
  const store: TenantFenceStore = {
    read: async () => fence,
    set: async (asked) => {
      calls.push(`${name} ${asked.state}`);
      if (fence.state !== "forgotten" && fence.state !== asked.state) fence = asked;
      return fence;
    },
  };
  return store;
};

const storesOf = (calls: string[], held: Partial<Record<string, TenantFence>> = {}) => ({
  tenant: "acme",
  storage: { fence: fenceOf("storage", calls, held.storage) },
  readModels: [
    { storage: { fence: fenceOf("orders", calls, held.orders) } },
    { storage: { fence: fenceOf("totals", calls, held.totals) } },
  ],
  ledger: { fence: fenceOf("ledger", calls, held.ledger) },
  tenantKeys: {
    freeze: async (at: string) => {
      calls.push(`keys frozen ${at}`);
      return at;
    },
    unfreeze: async () => {
      calls.push("keys open");
    },
  },
});

describe("freezing a tenant's stores", () => {
  it("fences the ledger, commits what it holds, then the database, the key record and the read models", async () => {
    const calls: string[] = [];
    const frozen = await freezeStores({
      ...storesOf(calls),
      clock: createFixedClock(new Date(AT)),
      drain: async () => {
        calls.push("drain");
      },
    });
    expect(frozen).toEqual({ tenant: "acme", frozenAt: AT });
    expect(calls).toEqual([
      "ledger frozen",
      "drain",
      "storage frozen",
      `keys frozen ${AT}`,
      "orders frozen",
      "totals frozen",
    ]);
  });

  it("waits for what a ledger whose reads lag its writes took, before it commits it", async () => {
    const calls: string[] = [];
    const clock = createFixedClock(new Date(AT));
    const stores = storesOf(calls);
    const freezing = freezeStores({
      ...stores,
      ledger: { ...stores.ledger, visibilityDelayMs: 60_000 },
      clock,
      drain: async () => {
        calls.push("drain");
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["ledger frozen"]);
    clock.advance(59_999);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["ledger frozen"]);
    clock.advance(1);
    await freezing;
    expect(calls).toEqual([
      "ledger frozen",
      "drain",
      "storage frozen",
      `keys frozen ${AT}`,
      "orders frozen",
      "totals frozen",
    ]);
  });

  it("finishes a freeze cut short with the time it first took", async () => {
    const calls: string[] = [];
    const later = createFixedClock(new Date("2026-04-01T00:00:00.000Z"));
    const frozen = await freezeStores({
      ...storesOf(calls, { storage: FROZEN }),
      ledger: null,
      tenantKeys: null,
      clock: later,
      drain: async () => undefined,
    });
    expect(frozen).toEqual({ tenant: "acme", frozenAt: AT });
    expect(calls).toEqual(["storage frozen", "orders frozen", "totals frozen"]);
  });

  it("refuses a forgotten tenant, by its database or by its ledger, before it freezes anything more", async () => {
    const calls: string[] = [];
    const clock = createFixedClock(new Date(AT));
    const drain = async () => {
      calls.push("drain");
    };
    await expect(
      freezeStores({ ...storesOf(calls, { storage: FORGOTTEN }), clock, drain }),
    ).rejects.toBeInstanceOf(TenantForgottenError);
    expect(calls).toEqual([]);
    await expect(
      freezeStores({ ...storesOf(calls, { ledger: FORGOTTEN }), clock, drain }),
    ).rejects.toMatchObject({ code: "TENANT_FORGOTTEN", forgottenAt: AT });
    expect(calls).toEqual(["ledger frozen"]);
  });

  it("refuses a tenant its database says forgotten once the drain committed", async () => {
    const calls: string[] = [];
    const stores = storesOf(calls);
    await expect(
      freezeStores({
        ...stores,
        clock: createFixedClock(new Date(AT)),
        drain: async () => {
          await stores.storage.fence.set(FORGOTTEN);
        },
      }),
    ).rejects.toBeInstanceOf(TenantForgottenError);
    expect(calls).toEqual(["ledger frozen", "storage forgotten", "storage frozen"]);
  });

  it("lifts every fence, the key record's first and the ledger's last, and refuses a forgotten tenant", async () => {
    const calls: string[] = [];
    await unfreezeStores(storesOf(calls, { storage: FROZEN }));
    expect(calls).toEqual([
      "keys open",
      "storage open",
      "orders open",
      "totals open",
      "ledger open",
    ]);
    const refused: string[] = [];
    await expect(unfreezeStores(storesOf(refused, { storage: FORGOTTEN }))).rejects.toBeInstanceOf(
      TenantForgottenError,
    );
    expect(refused).toEqual([]);
    await expect(unfreezeStores(storesOf([], { ledger: FORGOTTEN }))).rejects.toBeInstanceOf(
      TenantForgottenError,
    );
    await expect(
      unfreezeStores({ ...storesOf([], { storage: FROZEN }), ledger: null, tenantKeys: null }),
    ).resolves.toBeUndefined();
  });

  it("finds the tenant wholly frozen only once every store is", async () => {
    const whole = { storage: FROZEN, orders: FROZEN, totals: FROZEN, ledger: FROZEN };
    expect(await whollyFrozen(storesOf([], whole))).toBe(AT);
    expect(await whollyFrozen({ ...storesOf([], whole), ledger: null })).toBe(AT);
    for (const open of ["storage", "orders", "totals", "ledger"]) {
      expect(
        await whollyFrozen(storesOf([], { ...whole, [open]: { state: "open" } })),
        open,
      ).toBeNull();
    }
    expect(await whollyFrozen(storesOf([], { ...whole, storage: FORGOTTEN }))).toBeNull();
  });
});

describe("what an instance knows of its tenant's freeze", () => {
  it("reads the fence again once the interval passed, or at once when asked, and says when it thawed", async () => {
    const clock = createFixedClock(new Date(AT));
    let fence: TenantFence = FROZEN;
    let reads = 0;
    const { logger, entries } = createRecordingLogger();
    const watch = createFenceWatch({
      storage: {
        fence: {
          read: async () => {
            reads += 1;
            return fence;
          },
          set: async (asked) => asked,
        },
      },
      clock,
      logger,
      frozen: true,
    });
    expect(watch.frozen()).toBe(true);
    fence = { state: "open" };
    await watch.check();
    expect([reads, watch.frozen()]).toEqual([0, true]);
    clock.advance(TENANT_CHECK_INTERVAL_MS - 1);
    await watch.check();
    expect(reads).toBe(0);
    clock.advance(1);
    await Promise.all([watch.check(), watch.check()]);
    expect([reads, watch.frozen()]).toEqual([1, false]);
    expect(entries.map(({ message }) => message)).toEqual([
      "the tenant is no longer frozen: its background work goes on",
    ]);
    fence = FROZEN;
    await watch.check({ now: true });
    expect([reads, watch.frozen()]).toEqual([2, true]);
    expect(entries).toHaveLength(1);
    // A clock set back reads again at once.
    clock.set(new Date(Date.parse(AT) - 1));
    await watch.check();
    expect(reads).toBe(3);
  });

  it("says nothing of a thaw when the tenant was never frozen", async () => {
    const clock = createFixedClock(new Date(AT));
    const { logger, entries } = createRecordingLogger();
    const watch = createFenceWatch({
      storage: { fence: { read: async () => ({ state: "open" }), set: async (asked) => asked } },
      clock,
      logger,
      frozen: false,
    });
    await watch.check({ now: true });
    expect(watch.frozen()).toBe(false);
    expect(entries).toEqual([]);
  });

  it("knows the tenant frozen from a write a freeze refused, and from no other error", async () => {
    const clock = createFixedClock(new Date(AT));
    const { logger, entries } = createRecordingLogger();
    let reads = 0;
    const watch = createFenceWatch({
      storage: {
        fence: {
          read: async () => {
            reads += 1;
            return FROZEN;
          },
          set: async (asked) => asked,
        },
      },
      clock,
      logger,
      frozen: false,
    });
    watch.refused(new Error("database down"));
    watch.refused(new TenantForgottenError("acme", AT));
    expect(watch.frozen()).toBe(false);
    clock.advance(TENANT_CHECK_INTERVAL_MS - 1);
    watch.refused(new TenantFrozenError("acme", AT));
    watch.refused(new TenantFrozenError("acme", AT));
    expect(watch.frozen()).toBe(true);
    expect(entries.map(({ message, fields }) => [message, fields])).toEqual([
      ["the tenant is frozen: its background work waits for it to thaw", { frozenAt: AT }],
    ]);
    // The refusal counts as a reading: the next one waits the interval from it.
    clock.advance(TENANT_CHECK_INTERVAL_MS - 1);
    await watch.check();
    expect(reads).toBe(0);
  });

  it("logs a write a fence refused as information, and any other error as an error", () => {
    const { logger, entries } = createRecordingLogger();
    const refused: unknown[] = [];
    const aware = fenceAwareLogger(logger, (error) => refused.push(error));
    const frozen = new TenantFrozenError("acme", AT);
    const forgotten = new TenantForgottenError("acme", AT);
    aware.error("a pass failed", { error: frozen, subscriber: "s" });
    aware.error("a pass failed", { error: forgotten });
    aware.error("a pass failed", { error: new Error("down") });
    aware.error("no fields");
    aware.warn("warned", { a: 1 });
    aware.info("told", { b: 2 });
    aware.debug("traced", { c: 3 });
    expect(refused).toEqual([frozen, forgotten]);
    expect(
      entries.map(({ level, message, fields }) => [
        level,
        message,
        fields?.errorName,
        fields?.fenced,
        fields?.subscriber ?? fields?.a ?? fields?.b ?? fields?.c,
      ]),
    ).toEqual([
      ["info", "a pass failed", "TenantFrozenError", "TENANT_FROZEN", "s"],
      ["info", "a pass failed", "TenantForgottenError", "TENANT_FORGOTTEN", undefined],
      ["error", "a pass failed", "Error", undefined, undefined],
      ["error", "no fields", undefined, undefined, undefined],
      ["warn", "warned", undefined, undefined, 1],
      ["info", "told", undefined, undefined, 2],
      ["debug", "traced", undefined, undefined, 3],
    ]);
  });
});

describe("keeping a freeze the tenant key record holds", () => {
  const keeperOf = (record: () => Promise<string | null>, held: TenantFence[]) => {
    const clock = createFixedClock(new Date(AT));
    const { logger, entries } = createRecordingLogger();
    const reads: string[] = [];
    const stores = held.map((fence, index) => {
      let current = fence;
      return {
        fence: {
          read: async () => {
            reads.push(`read ${index}`);
            return current;
          },
          set: async (asked: TenantFence) => {
            reads.push(`set ${index} ${asked.state}`);
            current = asked;
            return current;
          },
        },
        current: () => current,
      };
    });
    const keeper = createFreezeKeeper({
      tenant: "acme",
      stores: () => stores,
      record,
      clock,
      logger,
    });
    return { keeper, clock, entries, reads, stores };
  };

  it("raises again the fence a database shows open while the record says frozen, and logs it", async () => {
    const { keeper, entries, stores } = keeperOf(async () => AT, [{ state: "open" }, FROZEN]);
    expect(await keeper.keep()).toBe(true);
    expect(stores.map(({ current }) => current())).toEqual([FROZEN, FROZEN]);
    expect(entries).toEqual([
      {
        level: "warn",
        message:
          "the tenant is frozen and a database's fence was open, as a copy restored by hand leaves it: raised again",
        fields: { tenant: "acme", frozenAt: AT, databases: 1 },
      },
    ]);
    expect(await keeper.keep()).toBe(false);
  });

  it("reads no fence while the record says the tenant is not frozen, and the record once an interval", async () => {
    let records = 0;
    const { keeper, clock, reads } = keeperOf(async () => {
      records += 1;
      return null;
    }, [{ state: "open" }]);
    expect(await keeper.keep()).toBe(false);
    expect(await keeper.keep()).toBe(false);
    expect([records, reads]).toEqual([1, []]);
    clock.advance(TENANT_CHECK_INTERVAL_MS - 1);
    await keeper.keep();
    expect(records).toBe(1);
    clock.advance(1);
    await keeper.keep();
    expect(records).toBe(2);
    // A clock set back reads it again at once.
    clock.set(new Date(Date.parse(AT) - 1));
    await keeper.keep();
    expect(records).toBe(3);
  });

  it("lowers back what it raised once a thaw lowered the record meanwhile", async () => {
    const answers = [AT, AT, null];
    const { keeper, stores, entries } = keeperOf(
      async () => answers.shift() ?? null,
      [{ state: "open" }],
    );
    expect(await keeper.keep()).toBe(false);
    expect(stores[0]?.current()).toEqual({ state: "open" });
    expect(entries).toEqual([]);
    expect(await keeper.keep()).toBe(false);
  });

  it("forgets a freeze the record no longer holds once it reads it again, and reads no fence then", async () => {
    const { keeper, clock, reads } = keeperOf(async () => null, [{ state: "open" }]);
    keeper.recorded(AT);
    clock.advance(TENANT_CHECK_INTERVAL_MS);
    expect(await keeper.keep()).toBe(false);
    expect(reads).toEqual([]);
  });

  it("raises nothing once the record, read again, says the freeze was lifted", async () => {
    const answers = [AT, null];
    const { keeper, reads } = keeperOf(async () => answers.shift() ?? null, [{ state: "open" }]);
    expect(await keeper.keep()).toBe(false);
    expect(reads).toEqual(["read 0"]);
    expect(await keeper.keep()).toBe(false);
    expect(reads).toEqual(["read 0"]);
  });

  it("raises nothing on a record it could not read, logged, and goes on with what it read before", async () => {
    let failing = false;
    let since: string | null = null;
    const { keeper, clock, stores, entries, reads } = keeperOf(async () => {
      if (failing) throw new Error("store down");
      return since;
    }, [{ state: "open" }]);
    expect(await keeper.keep()).toBe(false);
    since = AT;
    keeper.recorded(AT);
    failing = true;
    expect(await keeper.keep()).toBe(false);
    expect(stores[0]?.current()).toEqual({ state: "open" });
    expect(reads).toEqual(["read 0"]);
    expect(entries).toEqual([
      {
        level: "error",
        message: "the tenant key record could not be read for the tenant's freeze",
        fields: expect.objectContaining({ errorName: "Error", errorMessage: "store down" }),
      },
    ]);
    clock.advance(TENANT_CHECK_INTERVAL_MS);
    failing = false;
    expect(await keeper.keep()).toBe(true);
    keeper.recorded(null);
    expect(await keeper.keep()).toBe(false);
  });
});
