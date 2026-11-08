import { describe, expect, it } from "vitest";
import {
  pendingEvent,
  testCommand,
  testContext,
  testDeadLetter,
} from "../adapter/testing/fixtures.ts";
import type { LogFields } from "../contracts/logger.ts";
import { silentLogger } from "../contracts/logger.ts";
import { memory } from "../memory/index.ts";
import { fieldBuilder as f } from "../modules/view.ts";
import { testWitnessOf } from "./witness.ts";

const sealed = (person: string, data: string, key = `fp-${person}`) => ({
  $personal: { person, key, iv: "iv", data },
});

const fields = {
  orderId: f.string().primaryKey(),
  customerId: f.string().index().person(),
  note: f.string().optional().personal(),
  total: f.number(),
};

interface Row {
  readonly orderId: string;
  readonly customerId: string;
  readonly note?: string;
  readonly total: number;
}

const forgetting = (personId: string, aggregateType = "bounda") => ({
  aggregateType,
  aggregateId: personId,
  expectedVersion: 0,
  events: [
    pendingEvent({
      id: `forgot-${personId}-${aggregateType}`,
      aggregateType,
      aggregateId: personId,
      version: 1,
      type: "PersonalDataForgotten",
      payload: { personId },
      person: personId,
    }),
  ],
});

describe("the witness of a test app's storage", () => {
  it("is one per adapter, and wraps an adapter once", () => {
    const adapter = memory();
    const witness = testWitnessOf(adapter);
    expect(testWitnessOf(adapter)).toBe(witness);
    expect(testWitnessOf(memory())).not.toBe(witness);
    expect(witness.storage(adapter)).toBe(witness.storage(adapter));
    expect(witness.storage(adapter)).not.toBe(adapter);
    expect(witness.storage(adapter).inspect).toBe(adapter.inspect);
  });

  it("keeps every envelope a store is handed, however deep, but no error text, with the key that opens it", async () => {
    const adapter = memory();
    const witness = testWitnessOf(adapter);
    const storage = await witness.storage(adapter).createStorage();
    await storage.scheduler.schedule({
      dedupeKey: "command:c1",
      command: testCommand("1", {
        notes: [{ deep: sealed("c-1", "one") }],
        again: sealed("c-1", "one"),
      }),
      executeAt: new Date("2026-01-01T00:00:00.000Z"),
      context: testContext,
    });
    await storage.transact(async (transaction) => {
      await transaction.deadLetterStore.add({
        ...testDeadLetter("dl-1"),
        person: "c-1",
        errorMessage: sealed("c-1", "message") as never,
        errorStack: sealed("c-1", "stack") as never,
        payload: { email: sealed("c-1", "two", "fp-other") },
      } as never);
    });
    witness.onPersonalKey("c-1", { key: "k", fingerprint: "fp-c-1", kid: null });
    expect(witness.sealedFor("c-1")).toEqual([
      {
        envelope: sealed("c-1", "one").$personal,
        key: { key: "k", fingerprint: "fp-c-1", kid: null },
      },
      { envelope: sealed("c-1", "two", "fp-other").$personal, key: null },
    ]);
    expect(witness.sealedFor("c-2")).toEqual([]);
    expect(await storage.scheduler.list()).toHaveLength(1);
  });

  it("keeps what a read model writes in its personal fields, by person, until they are forgotten", async () => {
    const adapter = memory();
    const witness = testWitnessOf(adapter);
    const observed = witness.storage(adapter);
    const storage = await observed.createStorage();
    const model = await observed.createReadModel<Row>({
      name: "orders",
      fields,
      logger: silentLogger,
    });
    await model.table.upsert({ orderId: "o-1", customerId: "c-1", note: "ring twice", total: 1 });
    await model.table.insert({ orderId: "o-2", customerId: "c-1", total: 2 });
    await model.table.update({ orderId: "o-2" }, { note: "leave it next door" });
    await model.table.update({ orderId: "o-2" }, { total: 3 });
    await model.transact({
      subscriber: "orders",
      wait: true,
      work: async ({ table }) => {
        await table.upsert({ orderId: "o-3", customerId: "c-2", note: "for bo", total: 1 });
      },
    });
    const rebuild = await observed.rebuildReadModel<Row>({
      name: "orders",
      fields,
      logger: silentLogger,
      progress: "rebuild:orders",
    });
    await rebuild.transact(async ({ table }) => {
      await table.insert({ orderId: "o-4", customerId: "c-1", note: "rebuilt", total: 1 });
    });
    await rebuild.abort();
    expect(witness.keptFor("c-1")).toEqual([]);

    await storage.eventStore.append(forgetting("c-1", "customer"));
    expect(witness.keptFor("c-1")).toEqual([]);
    await storage.eventStore.append(forgetting("c-1"));
    expect(witness.keptFor("c-1")).toEqual(["ring twice", "leave it next door", "rebuilt"]);
    expect(witness.keptFor("c-2")).toEqual([]);

    await model.table.upsert({ orderId: "o-5", customerId: "c-1", note: "given again", total: 1 });
    expect(witness.keptFor("c-1")).toEqual(["ring twice", "leave it next door", "rebuilt"]);
    expect(await model.table.findOne({ orderId: "o-2" })).toMatchObject({ total: 3 });
  });

  it("keeps nothing of a row that names nobody", async () => {
    const adapter = memory();
    const witness = testWitnessOf(adapter);
    const observed = witness.storage(adapter);
    const storage = await observed.createStorage();
    const model = await observed.createReadModel<{ readonly id: string; readonly note?: string }>({
      name: "notes",
      fields: { id: f.string().primaryKey(), note: f.string().optional() },
      logger: silentLogger,
    });
    await model.table.upsert({ id: "c-1", note: "ring twice" });
    await storage.eventStore.append(forgetting("c-1"));
    expect(witness.keptFor("c-1")).toEqual([]);
  });

  it("records every entry logged, and hands it on", () => {
    const witness = testWitnessOf(memory());
    const seen: [string, string, LogFields | undefined][] = [];
    const logger = witness.logger({
      debug: (message, fields) => seen.push(["debug", message, fields]),
      info: (message, fields) => seen.push(["info", message, fields]),
      warn: (message, fields) => seen.push(["warn", message, fields]),
      error: (message, fields) => seen.push(["error", message, fields]),
    });
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e", { b: 2 });
    expect(witness.logs).toEqual([
      { level: "debug", message: "d", fields: undefined },
      { level: "info", message: "i", fields: { a: 1 } },
      { level: "warn", message: "w", fields: undefined },
      { level: "error", message: "e", fields: { b: 2 } },
    ]);
    expect(seen).toEqual([
      ["debug", "d", undefined],
      ["info", "i", { a: 1 }],
      ["warn", "w", undefined],
      ["error", "e", { b: 2 }],
    ]);
  });
});
