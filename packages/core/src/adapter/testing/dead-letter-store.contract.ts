import { beforeEach, describe, expect, it } from "vitest";
import { DeadLetterSettledError } from "../../contracts/errors.ts";
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
  handler: "order.notifyOnOrderPlaced",
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

    it("keeps the payload of a dropped command and has none for the others", async () => {
      const payload = { orderId: "o-1", items: [{ sku: "a", quantity: 2 }], note: null };
      await store.add(
        letter("cmd", {
          kind: "scheduled",
          handler: "PlaceOrder",
          eventType: "PlaceOrder",
          payload,
        }),
      );
      await store.add(letter("evt"));
      expect((await store.get("cmd"))?.payload).toEqual(payload);
      expect(await store.get("evt")).not.toHaveProperty("payload");
      expect((await store.list({ kind: "scheduled" }))[0]?.payload).toEqual(payload);
    });

    it("keeps a payload that is a bare boolean", async () => {
      await store.add(letter("bool", { kind: "scheduled", payload: true }));
      expect((await store.get("bool"))?.payload).toBe(true);
    });

    it("is idempotent on id", async () => {
      await store.add(letter("a"));
      await store.add(letter("a", { attempts: 99 }));
      expect(await store.list()).toHaveLength(1);
      expect((await store.get("a"))?.attempts).toBe(3);
    });

    it("lists and counts with filters and paging", async () => {
      await store.add(letter("a"));
      await store.add(letter("b", { kind: "process", handler: "order.orderPayment" }));
      await store.add(letter("c", { handler: "order.archiveOnOrderPaid" }));
      await store.updateStatus("c", "retried");

      expect((await store.list()).map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
      expect((await store.list({ kind: "process" })).map((entry) => entry.id)).toEqual(["b"]);
      expect(
        (await store.list({ handler: "order.notifyOnOrderPlaced" })).map((entry) => entry.id),
      ).toEqual(["a"]);
      expect((await store.list({ status: "failed" })).map((entry) => entry.id).sort()).toEqual([
        "a",
        "b",
      ]);
      expect(await store.count()).toBe(3);
      expect(await store.count({ status: "retried" })).toBe(1);
      const page = await store.list({ limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
      expect(await store.list({ offset: 2 })).toHaveLength(1);
      expect(await store.list({ limit: 2 })).toHaveLength(2);
    });

    it("rejects a status update for a letter it does not hold", async () => {
      const settled = await store
        .updateStatus("missing", "retried")
        .catch((error: unknown) => error);
      expect(settled).toBeInstanceOf(DeadLetterSettledError);
      expect(settled).toMatchObject({ code: "DEAD_LETTER_SETTLED", id: "missing" });
      expect(await store.get("missing")).toBeNull();
    });

    it("changes a letter's status only while it is failed, and keeps the first change", async () => {
      await store.add(letter("a"));
      await store.add(letter("b"));
      await store.updateStatus("a", "retried");
      await store.updateStatus("b", "discarded");

      await expect(store.updateStatus("a", "discarded")).rejects.toBeInstanceOf(
        DeadLetterSettledError,
      );
      await expect(store.updateStatus("a", "retried")).rejects.toBeInstanceOf(
        DeadLetterSettledError,
      );
      await expect(store.updateStatus("b", "retried")).rejects.toBeInstanceOf(
        DeadLetterSettledError,
      );
      expect((await store.get("a"))?.status).toBe("retried");
      expect((await store.get("b"))?.status).toBe("discarded");
    });

    it("lets one of two concurrent status changes through", async () => {
      await store.add(letter("a"));
      const outcomes = await Promise.allSettled([
        store.updateStatus("a", "retried"),
        store.updateStatus("a", "discarded"),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
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
