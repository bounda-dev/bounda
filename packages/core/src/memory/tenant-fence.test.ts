import { describe, expect, it } from "vitest";
import type { Storage } from "../adapter/adapter.ts";
import { silentLogger } from "../contracts/logger.ts";
import { fieldBuilder as f } from "../modules/view.ts";
import { memory } from "./index.ts";
import { createMemoryTenantFence, FENCED_WRITES } from "./tenant-fence.ts";

// What each store answers without changing anything, which the fence lets through.
const READS: Readonly<Record<string, readonly string[]>> = {
  eventStore: ["lastPosition", "load", "readAll", "readByPerson", "readOne", "rows"],
  inboxLedger: ["get"],
  deadLetterStore: [
    "count",
    "failedByHandler",
    "firstHeldAt",
    "firstResolvedAt",
    "get",
    "list",
    "listByPerson",
    "listFailed",
    "listHeld",
    "scan",
  ],
  scheduler: ["get", "list", "listByPerson", "nextDueAt", "scan"],
  idempotencyStore: ["get", "list", "listByPerson"],
  personalKeys: [
    "categories",
    "countDue",
    "countRetained",
    "countSuperseded",
    "countWrappedUnder",
    "find",
    "get",
    "kids",
    "list",
    "listDue",
    "listMany",
    "listRetained",
    "listWrappedUnder",
    "nextDueHoldEnd",
    "nextHoldEnd",
    "nextRetainedHoldEnd",
    "persons",
    "predecessors",
  ],
  persons: ["countIdle", "get", "listIdle", "nextHoldEnd", "restrictions", "scan"],
  recipients: ["declared", "disclosures", "disclosuresOfMany", "personsOf", "received", "summary"],
  snapshotStore: ["get", "rows"],
  subscriberFailures: ["get", "list", "rows"],
  indexKeys: ["get", "previous", "rows"],
  checkpointStore: ["get", "list", "rows"],
};

describe("the memory adapter's fence", () => {
  it("names every method of every store a write or a read, and no other", async () => {
    const storage = await memory().createStorage();
    for (const [name, writes] of Object.entries(FENCED_WRITES)) {
      if (name === "table") continue;
      const store = storage[name as keyof Storage] as object;
      expect(Object.keys(store).sort(), name).toEqual([...writes, ...(READS[name] ?? [])].sort());
    }
  });

  it("refuses a write at once while raised, and raises once the writes under way end", async () => {
    const fence = createMemoryTenantFence();
    let release: () => void = () => undefined;
    const writing = fence.write(() => new Promise<void>((resolve) => (release = resolve)));
    let raised = false;
    const raising = fence.store
      .set({ state: "frozen", tenant: "acme", since: "2026-03-01T00:00:00.000Z" })
      .then(() => {
        raised = true;
      });
    await expect(fence.write(async () => "late")).rejects.toMatchObject({
      code: "TENANT_FROZEN",
    });
    await Promise.resolve();
    expect(raised).toBe(false);
    release();
    await writing;
    await raising;
    expect(raised).toBe(true);
    expect(fence.rows()).toEqual([
      { scope: "app", tenant: "acme", state: "frozen", since: "2026-03-01T00:00:00.000Z" },
    ]);
    await fence.store.set({ state: "open" });
    expect(fence.rows()).toEqual([]);
    await expect(fence.write(async () => "again")).resolves.toBe("again");
  });

  it("raises only once every write under way ended, not the first", async () => {
    const fence = createMemoryTenantFence();
    const releases: (() => void)[] = [];
    const writes = [0, 1].map(() =>
      fence.write(() => new Promise<void>((resolve) => releases.push(resolve))),
    );
    let raised = false;
    const raising = fence.store
      .set({ state: "frozen", tenant: "acme", since: "2026-03-01T00:00:00.000Z" })
      .then(() => {
        raised = true;
      });
    releases[0]?.();
    await writes[0];
    await Promise.resolve();
    expect(raised).toBe(false);
    releases[1]?.();
    await writes[1];
    await raising;
    expect(raised).toBe(true);
  });

  it("refuses the writes a read model's restricted views hand out, as its table's", async () => {
    const adapter = memory();
    const readModel = await adapter.createReadModel<Record<string, unknown>>({
      name: "orders",
      fields: { orderId: f.string().primaryKey() },
      logger: silentLogger,
    });
    await readModel.fence.set({
      state: "frozen",
      tenant: "acme",
      since: "2026-03-01T00:00:00.000Z",
    });
    for (const view of [readModel.restricted.unrestricted, readModel.restricted.retained]) {
      await expect(view.upsert({ orderId: "o-1" })).rejects.toMatchObject({
        code: "TENANT_FROZEN",
      });
    }
    expect(await readModel.restricted.unrestricted.findMany()).toEqual([]);
  });
});
