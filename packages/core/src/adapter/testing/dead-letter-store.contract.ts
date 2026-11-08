import { beforeEach, describe, expect, it } from "vitest";
import { DeadLetterSettledError } from "../../contracts/errors.ts";
import type { DeadLetterStore, NewDeadLetter } from "../storage/dead-letter-store.ts";
import { testKeyedPerson as held, testSealedValue as sealed } from "./fixtures.ts";

// When a test resolves a letter.
const resolvedAt = new Date("2026-01-03T00:00:00.000Z");

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
  person: null,
  errorType: "retriable_exhausted",
  errorName: "Error",
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
      expect(added).toEqual({
        ...letter("a"),
        status: "failed",
        errorStack: "Error: timeout\n  at x",
      });
      expect(await store.get("a")).toEqual(added);
      expect(await store.get("missing")).toBeNull();
    });

    it("keeps the error's name, its code when it has one, and the person the work names", async () => {
      await store.add(letter("coded", { errorCode: "VALIDATION_FAILED", person: "c-1" }));
      await store.add(letter("plain"));
      expect(await store.get("coded")).toMatchObject({
        errorName: "Error",
        errorCode: "VALIDATION_FAILED",
        person: "c-1",
      });
      expect(await store.get("plain")).toMatchObject({ errorName: "Error", person: null });
      expect(await store.get("plain")).not.toHaveProperty("errorCode");
    });

    it("keeps sealed error text as it is, next to text in the clear", async () => {
      const message = sealed("c-1", "1");
      const stack = { $personal: { ...message.$personal, data: "stack" } };
      await store.add(
        letter("sealed", { person: "c-1", errorMessage: message, errorStack: stack }),
      );
      await store.add(
        letter("clear", { errorMessage: '{"$personal":"looks sealed"}', errorStack: "[]" }),
      );
      expect(await store.get("sealed")).toMatchObject({ errorMessage: message, errorStack: stack });
      expect(await store.get("clear")).toMatchObject({
        errorMessage: '{"$personal":"looks sealed"}',
        errorStack: "[]",
      });
      expect((await store.list()).map(({ id, errorMessage }) => [id, errorMessage])).toEqual([
        ["clear", '{"$personal":"looks sealed"}'],
        ["sealed", message],
      ]);
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

    it("hands out payloads as JSON keeps them, which changing does not change the store", async () => {
      await store.add(
        letter("cmd", {
          kind: "scheduled",
          payload: { at: new Date("2026-01-01T00:00:00.000Z"), lines: ["a"] },
        }),
      );
      const fetched = await store.get("cmd");
      if (fetched === null) throw new Error("the letter was not added");
      expect(fetched.payload).toEqual({ at: "2026-01-01T00:00:00.000Z", lines: ["a"] });
      (fetched.payload as { lines: string[] }).lines.push("b");
      const [listed] = await store.list();
      expect(listed?.payload).toEqual({ at: "2026-01-01T00:00:00.000Z", lines: ["a"] });
    });

    it("keeps a payload that is a bare boolean", async () => {
      await store.add(letter("bool", { kind: "scheduled", payload: true }));
      expect((await store.get("bool"))?.payload).toBe(true);
    });

    it("lists the oldest failure first, then by id, whatever the order they were added in", async () => {
      await store.add(letter("b", { firstFailedAt: "2026-01-02T00:00:00.000Z" }));
      await store.add(letter("\u{1F600}", { firstFailedAt: "2026-01-02T00:00:00.000Z" }));
      await store.add(letter("c", { firstFailedAt: "2026-01-01T00:00:00.000Z" }));
      await store.add(letter("！", { firstFailedAt: "2026-01-02T00:00:00.000Z" }));
      await store.add(letter("a", { firstFailedAt: "2026-01-02T00:00:00.000Z" }));
      expect((await store.list()).map(({ id }) => id)).toEqual(["c", "a", "b", "！", "\u{1F600}"]);
      expect((await store.list({ limit: 1 })).map(({ id }) => id)).toEqual(["c"]);
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
      await store.updateStatus("c", "retried", resolvedAt);

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

    it("finds the failed letters of a person's work by the error's code, in the order of list", async () => {
      const refused = (id: string, person: string | null, at = "2026-01-01T00:00:00.000Z") =>
        letter(id, { person, errorCode: "PROCESSING_RESTRICTED", firstFailedAt: at });
      await store.add(refused("b", "c-1", "2026-01-02T00:00:00.000Z"));
      await store.add(refused("a", "c-1", "2026-01-02T00:00:00.000Z"));
      await store.add(refused("c", "c-1"));
      await store.add(refused("settled", "c-1"));
      await store.add(refused("other", "c-2"));
      await store.add(refused("nobody", null));
      await store.add(letter("coded", { person: "c-1", errorCode: "VALIDATION_FAILED" }));
      await store.add(letter("plain", { person: "c-1" }));
      await store.updateStatus("settled", "retried", resolvedAt);
      const found = await store.listFailed({ person: "c-1", errorCode: "PROCESSING_RESTRICTED" });
      expect(found.map(({ id }) => id)).toEqual(["c", "a", "b"]);
      expect(found[0]).toEqual({ ...refused("c", "c-1"), status: "failed" });
      expect(await store.listFailed({ person: "c-3", errorCode: "PROCESSING_RESTRICTED" })).toEqual(
        [],
      );
    });

    it("rejects a status update for a letter it does not hold", async () => {
      const settled = await store
        .updateStatus("missing", "retried", resolvedAt)
        .catch((error: unknown) => error);
      expect(settled).toBeInstanceOf(DeadLetterSettledError);
      expect(settled).toMatchObject({ code: "DEAD_LETTER_SETTLED", id: "missing" });
      expect(await store.get("missing")).toBeNull();
    });

    it("changes a letter's status only while it is failed, and keeps the first change", async () => {
      await store.add(letter("a"));
      await store.add(letter("b"));
      await store.updateStatus("a", "retried", resolvedAt);
      await store.updateStatus("b", "discarded", resolvedAt);

      await expect(store.updateStatus("a", "discarded", resolvedAt)).rejects.toBeInstanceOf(
        DeadLetterSettledError,
      );
      await expect(store.updateStatus("a", "retried", resolvedAt)).rejects.toBeInstanceOf(
        DeadLetterSettledError,
      );
      await expect(
        store.updateStatus("b", "retried", new Date("2026-02-01T00:00:00.000Z")),
      ).rejects.toBeInstanceOf(DeadLetterSettledError);
      expect(await store.get("a")).toMatchObject({
        status: "retried",
        resolvedAt: resolvedAt.toISOString(),
      });
      expect(await store.get("b")).toMatchObject({
        status: "discarded",
        resolvedAt: resolvedAt.toISOString(),
      });
    });

    it("has no resolution time for a letter still failed", async () => {
      await store.add(letter("a"));
      expect(await store.get("a")).not.toHaveProperty("resolvedAt");
      expect(await store.firstResolvedAt()).toBeNull();
      expect(await store.purge({ resolvedBy: new Date("2100-01-01"), limit: 10 })).toBe(0);
      expect(await store.get("a")).not.toBeNull();
    });

    it("purges the resolved letters up to a time, earliest first, never a failed one", async () => {
      const at = (day: number) => new Date(Date.UTC(2026, 0, day));
      await store.add(letter("failed"));
      for (const id of ["late", "b", "a", "first"]) await store.add(letter(id));
      await store.updateStatus("late", "retried", at(9));
      await store.updateStatus("b", "discarded", at(5));
      await store.updateStatus("a", "retried", at(5));
      await store.updateStatus("first", "discarded", at(2));
      expect(await store.firstResolvedAt()).toEqual(at(2));

      expect(await store.purge({ resolvedBy: at(5), limit: 2 })).toBe(2);
      expect((await store.list()).map(({ id }) => id).sort()).toEqual(["b", "failed", "late"]);
      expect(await store.firstResolvedAt()).toEqual(at(5));
      expect(await store.purge({ resolvedBy: at(4), limit: 10 })).toBe(0);
      expect(await store.purge({ resolvedBy: at(5), limit: 10 })).toBe(1);
      expect((await store.list()).map(({ id }) => id).sort()).toEqual(["failed", "late"]);
      expect(await store.firstResolvedAt()).toEqual(at(9));
      expect(await store.purge({ resolvedBy: at(30), limit: 10 })).toBe(1);
      expect(await store.firstResolvedAt()).toBeNull();
      expect((await store.list()).map(({ id }) => id)).toEqual(["failed"]);
    });

    it("lets one of two concurrent status changes through", async () => {
      await store.add(letter("a"));
      const outcomes = await Promise.allSettled([
        store.updateStatus("a", "retried", resolvedAt),
        store.updateStatus("a", "discarded", resolvedAt),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const [rejected] = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(rejected?.reason).toBeInstanceOf(DeadLetterSettledError);
    });

    it("keeps whose personal data a letter holds, and forgets the ones that name a person, whatever their status", async () => {
      const scheduled = (id: string, at: string, persons?: NewDeadLetter["persons"]) =>
        letter(id, {
          kind: "scheduled",
          handler: "PlaceOrder",
          eventType: "PlaceOrder",
          firstFailedAt: at,
          payload: { orderId: id },
          ...(persons === undefined ? {} : { persons }),
        });
      await store.add(scheduled("a", "2026-01-01T00:02:00.000Z", [held("c-1", "1")]));
      await store.add(
        scheduled("b", "2026-01-01T00:01:00.000Z", [held("c-2", "2"), held("c-1", "1")]),
      );
      await store.add(scheduled("c", "2026-01-01T00:00:00.000Z", [held("c-2", "2")]));
      await store.add(scheduled("d", "2026-01-01T00:00:00.000Z"));
      await store.add(scheduled("e", "2026-01-01T00:00:00.000Z", []));
      await store.updateStatus("b", "discarded", resolvedAt);
      expect((await store.get("a"))?.persons).toEqual([held("c-1", "1")]);
      expect(await store.get("d")).not.toHaveProperty("persons");
      expect(await store.get("e")).not.toHaveProperty("persons");

      const named = await store.listByPerson("c-1");
      expect(named.map((letter) => [letter.id, letter.status])).toEqual([
        ["b", "discarded"],
        ["a", "failed"],
      ]);
      expect(await store.listByPerson("c")).toEqual([]);
      expect(await store.count()).toBe(5);

      const forgotten = await store.forget("c-1");
      expect(forgotten).toEqual(named);
      expect(forgotten).toEqual([
        {
          ...scheduled("b", "2026-01-01T00:01:00.000Z", [held("c-2", "2"), held("c-1", "1")]),
          status: "discarded",
          resolvedAt: resolvedAt.toISOString(),
        },
        { ...scheduled("a", "2026-01-01T00:02:00.000Z", [held("c-1", "1")]), status: "failed" },
      ]);
      expect((await store.list()).map((kept) => kept.id)).toEqual(["c", "d", "e"]);
      expect(await store.forget("c-1")).toEqual([]);
      expect(await store.listByPerson("c-1")).toEqual([]);
    });

    it("leaves the letters that name a person only as the person of their work", async () => {
      await store.add(
        letter("policy", {
          person: "c-1",
          errorMessage: sealed("c-1", "1"),
          errorStack: sealed("c-1", "1"),
        }),
      );
      await store.add(
        letter("process", {
          kind: "process",
          handler: "order.orderPayment",
          person: "c-1",
          errorMessage: sealed("c-1", "1"),
        }),
      );
      expect(await store.forget("c-1")).toEqual([]);
      expect((await store.list()).map(({ id }) => id)).toEqual(["policy", "process"]);
      expect((await store.get("policy"))?.errorMessage).toEqual(sealed("c-1", "1"));
    });

    it("lists the letters that name a person in their work or in their payload, in the order of list", async () => {
      await store.add(
        letter("process", {
          kind: "process",
          handler: "order.orderPayment",
          person: "c-1",
          firstFailedAt: "2026-01-01T00:02:00.000Z",
          errorMessage: sealed("c-1", "1"),
        }),
      );
      await store.add(
        letter("scheduled", {
          kind: "scheduled",
          handler: "PlaceOrder",
          eventType: "PlaceOrder",
          firstFailedAt: "2026-01-01T00:01:00.000Z",
          payload: { orderId: "o-1" },
          persons: [held("c-1", "1")],
        }),
      );
      await store.add(letter("other", { person: "c-2", errorMessage: sealed("c-2", "2") }));
      await store.add(letter("nobody"));
      await store.updateStatus("process", "retried", resolvedAt);

      const named = await store.listByPerson("c-1");
      expect(named.map(({ id, status }) => [id, status])).toEqual([
        ["scheduled", "failed"],
        ["process", "retried"],
      ]);
      expect(named[1]).toEqual(await store.get("process"));
      expect((await store.listByPerson("c-2")).map(({ id }) => id)).toEqual(["other"]);
      expect(await store.listByPerson("c-3")).toEqual([]);
    });

    it("reseals a letter in place, whatever its status, keeping the rest of it", async () => {
      await store.add(letter("p", { errorStack: "Error: timeout\n    at handler" }));
      await store.add(
        letter("s", { kind: "scheduled", handler: "RemindCustomer", payload: { email: "a" } }),
      );
      await store.updateStatus("s", "discarded", resolvedAt);
      const [policy, scheduled] = [await store.get("p"), await store.get("s")];
      await store.reseal("p", {
        person: "c-1",
        errorMessage: sealed("c-1", "1"),
        errorStack: sealed("c-1", "1"),
      });
      await store.reseal("s", {
        person: "c-2",
        errorMessage: sealed("c-2", "2"),
        payload: { email: sealed("c-2", "2") },
        persons: [held("c-2", "2")],
      });
      await store.reseal("missing", { person: "c-1", errorMessage: "lost" });

      expect(await store.get("p")).toEqual({
        ...policy,
        person: "c-1",
        errorMessage: sealed("c-1", "1"),
        errorStack: sealed("c-1", "1"),
      });
      expect(await store.get("s")).toEqual({
        ...scheduled,
        person: "c-2",
        errorMessage: sealed("c-2", "2"),
        payload: { email: sealed("c-2", "2") },
        persons: [held("c-2", "2")],
      });
      expect(await store.get("missing")).toBeNull();
      expect((await store.listByPerson("c-1")).map(({ id }) => id)).toEqual(["p"]);
      expect((await store.forget("c-2")).map(({ id }) => id)).toEqual(["s"]);
      expect(await store.forget("c-1")).toEqual([]);
    });

    it("reseals what a letter leaves out as none", async () => {
      await store.add(
        letter("s", {
          kind: "scheduled",
          errorStack: "stack",
          payload: { email: "a" },
          persons: [held("c-1", "1")],
        }),
      );
      await store.reseal("s", { person: null, errorMessage: "timeout" });
      const resealed = await store.get("s");
      expect(resealed).not.toHaveProperty("errorStack");
      expect(resealed).not.toHaveProperty("payload");
      expect(resealed).not.toHaveProperty("persons");
      expect(await store.forget("c-1")).toEqual([]);
    });

    it("updates status and removes letters", async () => {
      await store.add(letter("a"));
      await store.updateStatus("a", "discarded", resolvedAt);
      expect((await store.get("a"))?.status).toBe("discarded");
      await store.remove("a");
      expect(await store.get("a")).toBeNull();
      await expect(store.remove("a")).resolves.toBeUndefined();
    });
  });
};
