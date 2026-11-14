import { beforeEach, describe, expect, it } from "vitest";
import type {
  NewSubscriberFailure,
  SubscriberFailureStore,
} from "../storage/subscriber-failure-store.ts";

export interface SubscriberFailureStoreContractArgs {
  readonly create: () => Promise<SubscriberFailureStore>;
}

export interface SubscriberFailureStoreContractFunction {
  (args: SubscriberFailureStoreContractArgs): void;
}

const at = (minute: number): string => new Date(Date.UTC(2026, 2, 1, 0, minute)).toISOString();

const failure = (overrides: Partial<NewSubscriberFailure> = {}): NewSubscriberFailure => ({
  subscriber: "projection:orders",
  position: 7,
  eventId: "e-7",
  eventType: "OrderPlaced",
  person: "c-1",
  errorName: "ValidationError",
  errorCode: "VALIDATION_FAILED",
  errorMessage: { $personal: { person: "c-1", key: "k", iv: "i", data: "d" } },
  errorStack: "Error: x\n    at f",
  failedAt: at(0),
  ...overrides,
});

/**
 * The behaviour every subscriber failure store must exhibit. Call it inside a `describe` of the
 * adapter's test file with a factory that returns a fresh, empty store.
 */
export const subscriberFailureStoreContract: SubscriberFailureStoreContractFunction = ({
  create,
}) => {
  describe("subscriber failure store contract", () => {
    let store: SubscriberFailureStore;

    beforeEach(async () => {
      store = await create();
    });

    it("keeps nothing for a subscriber that never failed, and resolves nothing for it", async () => {
      expect(await store.get("projection:orders")).toBeNull();
      await store.resolve("projection:orders", new Date(at(1)));
      expect(await store.list()).toEqual([]);
    });

    it("keeps a failure as it was recorded, sealed text, stack and code included", async () => {
      await store.record(failure());
      const { failedAt: _failedAt, ...recorded } = failure();
      expect(await store.get("projection:orders")).toEqual({
        ...recorded,
        attempts: 1,
        firstFailedAt: at(0),
        lastFailedAt: at(0),
        resolvedAt: null,
      });
    });

    it("keeps text in the clear apart from a sealed envelope, and an error without code or stack", async () => {
      const {
        errorCode: _code,
        errorStack: _stack,
        ...bare
      } = failure({
        person: null,
        errorMessage: '{"$personal":"not sealed"}',
      });
      await store.record(bare);
      expect(await store.get("projection:orders")).toEqual(
        expect.objectContaining({ person: null, errorMessage: '{"$personal":"not sealed"}' }),
      );
      const kept = await store.get("projection:orders");
      expect(kept).not.toHaveProperty("errorCode");
      expect(kept).not.toHaveProperty("errorStack");
    });

    it("counts the failures in a row on one event, and starts again on another", async () => {
      await store.record(failure());
      await store.record(failure({ failedAt: at(1) }));
      await store.record(failure({ failedAt: at(2), errorName: "TypeError" }));
      expect(await store.get("projection:orders")).toMatchObject({
        attempts: 3,
        firstFailedAt: at(0),
        lastFailedAt: at(2),
        errorName: "TypeError",
      });
      await store.record(failure({ position: 9, eventId: "e-9", failedAt: at(3) }));
      expect(await store.get("projection:orders")).toMatchObject({
        position: 9,
        eventId: "e-9",
        attempts: 1,
        firstFailedAt: at(3),
        lastFailedAt: at(3),
      });
    });

    it("resolves the last failure once, and counts afresh a failure on the same event after it", async () => {
      await store.record(failure());
      await store.resolve("projection:orders", new Date(at(5)));
      await store.resolve("projection:orders", new Date(at(6)));
      expect(await store.get("projection:orders")).toMatchObject({ resolvedAt: at(5) });
      await store.record(failure({ failedAt: at(7) }));
      expect(await store.get("projection:orders")).toMatchObject({
        attempts: 1,
        firstFailedAt: at(7),
        resolvedAt: null,
      });
    });

    it("reseals the text of the failure still on the event, and nothing else of it", async () => {
      await store.record(failure());
      await store.record(failure({ failedAt: at(1) }));
      await store.resolve("projection:orders", new Date(at(2)));
      const sealed = { $personal: { person: "c-1", key: "gone", iv: "i2", data: "d2" } };
      await store.reseal("projection:orders", { eventId: "e-7", errorMessage: sealed });
      const { failedAt: _failedAt, errorStack: _errorStack, ...recorded } = failure();
      expect(await store.get("projection:orders")).toEqual({
        ...recorded,
        errorMessage: sealed,
        attempts: 2,
        firstFailedAt: at(0),
        lastFailedAt: at(1),
        resolvedAt: at(2),
      });
      await store.reseal("projection:orders", {
        eventId: "e-7",
        errorMessage: "m",
        errorStack: sealed,
      });
      expect(await store.get("projection:orders")).toMatchObject({
        errorMessage: "m",
        errorStack: sealed,
      });
    });

    it("leaves a later failure on another event, and a subscriber without one, as they are", async () => {
      await store.record(failure({ eventId: "e-8", position: 8 }));
      await store.reseal("projection:orders", { eventId: "e-7", errorMessage: "m" });
      await store.reseal("projection:other", { eventId: "e-7", errorMessage: "m" });
      expect(await store.get("projection:orders")).toMatchObject({
        eventId: "e-8",
        errorMessage: failure().errorMessage,
        errorStack: failure().errorStack,
      });
      expect(await store.get("projection:other")).toBeNull();
    });

    it("keeps one row per subscriber, listed by subscriber", async () => {
      await store.record(failure({ subscriber: "policies" }));
      await store.record(failure({ subscriber: "Processes" }));
      await store.record(failure());
      expect((await store.list()).map(({ subscriber }) => subscriber)).toEqual([
        "Processes",
        "policies",
        "projection:orders",
      ]);
    });

    it("counts both of two instances failing on the same event at once", async () => {
      await store.record(failure());
      await Promise.all([
        store.record(failure({ failedAt: at(1) })),
        store.record(failure({ failedAt: at(1) })),
      ]);
      expect(await store.get("projection:orders")).toMatchObject({ attempts: 3 });
    });
  });
};
