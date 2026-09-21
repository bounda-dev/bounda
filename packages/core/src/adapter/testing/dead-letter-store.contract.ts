import { beforeEach, describe, expect, it } from "vitest";
import type { DeadLetterStore, NewDeadLetter } from "../ports/dead-letter-store.ts";

export interface DeadLetterStoreContractArgs {
  readonly create: () => Promise<DeadLetterStore>;
}

export interface DeadLetterStoreContractFunction {
  (args: DeadLetterStoreContractArgs): void;
}

const letter = (id: string, overrides: Partial<NewDeadLetter> = {}): NewDeadLetter => ({
  id,
  kind: "policy",
  subscriber: "policies",
  eventId: `evt-${id}`,
  eventType: "OrderPlaced",
  aggregateType: "order",
  aggregateId: "1",
  errorType: "retriable_exhausted",
  errorMessage: "timeout",
  attempts: 3,
  firstFailedAt: "2026-01-01T00:00:00.000Z",
  lastFailedAt: "2026-01-01T00:05:00.000Z",
  ...overrides,
});

/**
 * The behaviour every dead-letter store must exhibit.
 */
export const deadLetterStoreContract: DeadLetterStoreContractFunction = ({ create }) => {
  describe("dead letter store contract", () => {
    let store: DeadLetterStore;

    beforeEach(async () => {
      store = await create();
    });

    it("adds letters as failed and reads them back", async () => {
      const added = await store.add(letter("a", { errorStack: "Error: timeout\n  at x" }));
      expect(added).toMatchObject({
        id: "a",
        status: "failed",
        errorStack: "Error: timeout\n  at x",
      });
      expect(await store.get("a")).toEqual(added);
      expect(await store.get("missing")).toBeNull();
    });

    it("is idempotent on id", async () => {
      await store.add(letter("a"));
      await store.add(letter("a", { attempts: 99 }));
      expect(await store.list()).toHaveLength(1);
      expect((await store.get("a"))?.attempts).toBe(3);
    });

    it("lists and counts with filters and paging", async () => {
      await store.add(letter("a"));
      await store.add(letter("b", { kind: "process", subscriber: "process:OrderPayment" }));
      await store.add(letter("c", { subscriber: "policies:other" }));
      await store.updateStatus("c", "replayed");

      expect((await store.list()).map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
      expect((await store.list({ kind: "process" })).map((entry) => entry.id)).toEqual(["b"]);
      expect((await store.list({ subscriber: "policies" })).map((entry) => entry.id)).toEqual([
        "a",
      ]);
      expect((await store.list({ status: "failed" })).map((entry) => entry.id).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(await store.count()).toBe(3);
      expect(await store.count({ status: "replayed" })).toBe(1);
      const page = await store.list({ limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
      expect(await store.list({ offset: 2 })).toHaveLength(1);
      expect(await store.list({ limit: 2 })).toHaveLength(2);
    });

    it("ignores a status update for a letter it does not hold", async () => {
      await expect(store.updateStatus("missing", "replayed")).resolves.toBeUndefined();
      expect(await store.get("missing")).toBeNull();
    });

    it("updates status and removes letters", async () => {
      await store.add(letter("a"));
      await store.updateStatus("a", "discarded");
      expect((await store.get("a"))?.status).toBe("discarded");
      await store.remove("a");
      expect(await store.get("a")).toBeNull();
      await expect(store.remove("a")).resolves.toBeUndefined();
    });
  });
};
