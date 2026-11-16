import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { createPersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { testMaster, testTenantKeys } from "../test-support.ts";
import { appStorage } from "./app-event-store.ts";

const setUp = async () => {
  const unwrapped: string[] = [];
  const written = await memory().createStorage();
  const wrapping = createPersonalKeyWrapping({
    tenantKeys: {
      ...testTenantKeys,
      keyOf: async (kid) => {
        unwrapped.push(kid);
        return testTenantKeys.keyOf(kid);
      },
    },
    master: testMaster,
    clock: createFixedClock(),
  });
  const storage = appStorage({
    storage: written,
    aggregates: buildAggregates({ registry: { aggregates: {}, readModels: {} }, ports: {} }),
    processes: { byName: {} },
    wrapping,
  });
  await storage.personalKeys.create("c-1", DEFAULT_PERSONAL_CATEGORY);
  const stored = await written.personalKeys.get("c-1", DEFAULT_PERSONAL_CATEGORY);
  if (stored === null) throw new Error("no key stored");
  // A read that started before a removal, as a projection's, keeps the key again.
  const readMeanwhile = () => wrapping.over(written.personalKeys).open("c-1", stored);
  return { unwrapped, written, storage, stored, readMeanwhile };
};

describe("appStorage", () => {
  it("keeps snapshots as the adapter stores them, and nothing to seal answers with, without keys", async () => {
    const { written, storage } = await setUp();
    expect(storage.atRest).toBeNull();
    expect(storage.snapshotStore).toBe(written.snapshotStore);
    await storage.transact(async (transaction) => {
      expect(transaction.snapshotStore).toBe(written.snapshotStore);
    });
  });

  it("drops a key a transaction removes once it commits, even one kept again meanwhile", async () => {
    const { unwrapped, written, storage, stored, readMeanwhile } = await setUp();
    expect(unwrapped).toHaveLength(0);
    await storage.transact(async (transaction) => {
      await transaction.personalKeys.remove("c-1", stored.fingerprint);
      await readMeanwhile();
    });
    expect(unwrapped).toHaveLength(1);
    // The row put back, as a restore would: unwrapped again, so the cache had let it go.
    await written.personalKeys.add("c-1", DEFAULT_PERSONAL_CATEGORY, stored);
    await storage.personalKeys.held("c-1", DEFAULT_PERSONAL_CATEGORY);
    expect(unwrapped).toHaveLength(2);
  });

  it("keeps a key whose removal did not commit", async () => {
    const { unwrapped, storage, stored, readMeanwhile } = await setUp();
    await expect(
      storage.transact(async (transaction) => {
        await transaction.personalKeys.remove("c-1", stored.fingerprint);
        await readMeanwhile();
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(await storage.personalKeys.held("c-1", DEFAULT_PERSONAL_CATEGORY)).not.toBeNull();
    expect(unwrapped).toHaveLength(1);
  });
});
