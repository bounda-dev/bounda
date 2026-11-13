import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import { PartialBatchError } from "../dispatch/delivery.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import type { ProjectionRuntime, ReadModelRuntime } from "../read-model/build-read-models.ts";
import { sealedLayoutOf } from "../read-model/sealed-rows.ts";
import { KeysMissingError } from "../read-model/sealing-keys.ts";
import { eachPerson } from "../test-support.ts";
import { batchPersons, createProjectionSubscriber, projectBatch, withKeys } from "./runner.ts";

const fields: FieldsRecord = {
  customerId: f.string().primaryKey().person(),
  email: f.string().optional().personal(),
};

const event = (type: string, aggregateType = "customer", payload: object = {}): StoredEvent => ({
  id: `e-${type}`,
  aggregateType,
  aggregateId: "ana",
  version: 1,
  position: 1,
  type,
  payload: { personId: "ana", categories: ["default"], retained: [], expired: [], ...payload },
  person: "ana",
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: { correlationId: "c", causationId: "c", depth: 0, schemaVersion: 1, system: true },
});

const projecting = (project: ProjectionRuntime["project"]) => ({
  name: "customers",
  projectionsByEvent: {
    "customer.CustomerRegistered": [
      {
        key: "customer.customerRegistered",
        aggregate: "customer",
        on: ["CustomerRegistered"],
        project,
      },
    ],
  },
});

const setUp = async (viewFields: FieldsRecord = fields) => {
  const layout = sealedLayoutOf({ readModel: "customers", fields: viewFields });
  const storage = await memory().createReadModel<Record<string, unknown>>({
    name: "customers",
    fields: layout.stored,
    logger: silentLogger,
  });
  return { layout, storage };
};

const budget = { clock: createFixedClock(), maxMs: 60_000 };

describe("projectBatch with sealed fields", () => {
  it("rejects with the persons it lacks keys for, whatever the projection throws around it, and runs again once they are fetched", async () => {
    const { layout, storage } = await setUp();
    const key: PersonalKey = await createDisposableKey();
    const fetched: string[][] = [];
    const run = (transaction: Parameters<typeof projectBatch>[0]["transaction"], keys: never) =>
      projectBatch({
        readModel: projecting(async ({ table }) => {
          await (table as { upsert(row: object): Promise<void> }).upsert({
            customerId: "ana",
            email: "a@x",
          });
        }),
        events: [event("CustomerRegistered")],
        transaction,
        sealing: { layout, keys, indexer: null },
        logger: silentLogger,
        errorText: "omit",
        budget,
      });
    const done = await withKeys({
      keys: eachPerson(async (person) => {
        fetched.push([person]);
        return [{ category: "default", key, retainedSince: null }];
      }),
      events: [event("CustomerRegistered")],
      run: (keys) =>
        storage
          .transact({
            subscriber: "s",
            wait: true,
            work: (transaction) => run(transaction, keys as never),
          })
          .then((outcome) => (outcome.acquired ? outcome.value : 0)),
    });
    expect(done).toBe(1);
    expect(fetched).toEqual([["ana"]]);
    const missing = await storage
      .transact({
        subscriber: "s",
        wait: true,
        work: (transaction) =>
          run(transaction, {
            forWrite: () => Promise.reject(new KeysMissingError(["bo"])),
            forOpen: () => Promise.reject(new KeysMissingError(["bo"])),
            kept: async () => false,
          } as never),
      })
      .catch((error: unknown) => error);
    expect(missing).toEqual(new KeysMissingError(["bo"]));
    expect(missing).toBeInstanceOf(KeysMissingError);
  });

  it("empties what a forgetting destroyed before the read model's own projections, and rejects with the events done when it cannot", async () => {
    const { layout, storage } = await setUp();
    const keys = {
      forWrite: () => createDisposableKey(),
      forOpen: async () => null,
      kept: async () => false,
      categoryOf: async () => null,
    };
    await storage.table.upsert({ customerId: "ana", email: "x", email__key: "f-1" });
    await storage.transact({
      subscriber: "s",
      wait: true,
      work: (transaction) =>
        projectBatch({
          readModel: { name: "customers", projectionsByEvent: {} },
          events: [
            event("PersonalDataForgotten", "bounda", { fingerprints: ["f-1"], email__index: 1 }),
          ],
          transaction,
          sealing: { layout, keys, indexer: null },
          logger: silentLogger,
          errorText: "omit",
          budget,
        }),
    });
    const failing = {
      ...storage.table,
      update: () => Promise.reject(new Error("down")),
    };
    const error = await projectBatch({
      readModel: { name: "customers", projectionsByEvent: {} },
      events: [
        event("Other", "customer"),
        event("PersonalDataForgotten", "bounda", { fingerprints: ["f-1"] }),
      ],
      transaction: { table: failing, client: storage.client, unsettled: async () => [] },
      sealing: { layout, keys, indexer: null },
      logger: silentLogger,
      errorText: "omit",
      budget,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartialBatchError);
    expect((error as PartialBatchError).done).toBe(1);
    const plain = await setUp({ id: f.string().primaryKey() });
    await expect(
      projectBatch({
        readModel: { name: "customers", projectionsByEvent: {} },
        events: [event("PersonalDataForgotten", "bounda")],
        transaction: { table: failing, client: plain.storage.client, unsettled: async () => [] },
        sealing: { layout: plain.layout, keys, indexer: null },
        logger: silentLogger,
        errorText: "omit",
        budget,
      }),
    ).resolves.toBe(1);
  });

  it("settles what the driver wrote only after a projection took it, and only in a read model with personal fields", async () => {
    const asked: string[] = [];
    const keys = {
      forWrite: () => createDisposableKey(),
      forOpen: async () => null,
      kept: async () => false,
      categoryOf: async () => null,
    };
    for (const [viewFields, takes, expected] of [
      [fields, true, ["unsettled"]],
      [fields, false, []],
      [{ id: f.string().primaryKey() }, true, []],
    ] as const) {
      asked.length = 0;
      const { layout, storage } = await setUp(viewFields);
      await projectBatch({
        readModel: projecting(async ({ client }) => {
          if (takes) void (client as { raw: unknown }).raw;
        }),
        events: [event("CustomerRegistered")],
        transaction: {
          table: storage.table,
          client: storage.client,
          unsettled: async () => {
            asked.push("unsettled");
            return [];
          },
        },
        sealing: { layout, keys, indexer: null },
        logger: silentLogger,
        errorText: "omit",
        budget,
      });
      expect(asked).toEqual(expected);
    }
  });
});

describe("createProjectionSubscriber", () => {
  it("reacts to a forgetting only for a read model with personal fields", async () => {
    const forgotten = "bounda.PersonalDataForgotten";
    for (const [viewFields, reacts] of [
      [fields, true],
      [{ id: f.string().primaryKey() }, false],
    ] as const) {
      const { layout, storage } = await setUp(viewFields);
      const subscriber = createProjectionSubscriber({
        readModel: {
          name: "customers",
          fields: viewFields,
          layout,
          storage,
          projectionsByEvent: {},
          personalData: null,
          queries: {},
        } as ReadModelRuntime,
        sealing: { keys: eachPerson(() => []), indexer: null },
        logger: silentLogger,
        errorText: "omit",
        budget,
      });
      expect(subscriber.reactsTo?.(forgotten)).toBe(reacts);
      expect(subscriber.reactsTo?.("customer.CustomerRegistered")).toBe(false);
    }
  });
});

describe("the keys of a batch", () => {
  it("names the person a forgetting in the batch is about, and the persons its events were opened for", () => {
    expect(
      batchPersons([event("PersonalDataForgotten", "bounda"), event("Other", "customer")]),
    ).toEqual(["ana"]);
    expect(batchPersons([event("Other", "customer")])).toEqual([]);
  });

  it("rejects with the person whose kept keys a forgetting needs, and the batch's", async () => {
    const { layout, storage } = await setUp();
    const error = await projectBatch({
      readModel: { name: "customers", projectionsByEvent: {} },
      events: [
        event("PersonalDataForgotten", "bounda", { retained: ["default"], fingerprints: ["f-1"] }),
      ],
      transaction: { table: storage.table, client: storage.client, unsettled: async () => [] },
      sealing: {
        layout,
        keys: {
          forWrite: () => createDisposableKey(),
          forOpen: async () => null,
          kept: async () => false,
          categoryOf: () => Promise.reject(new KeysMissingError(["bo"])),
        },
        indexer: null,
      },
      logger: silentLogger,
      errorText: "omit",
      budget,
    }).catch((caught: unknown) => caught);
    expect(error).toEqual(new KeysMissingError(["bo", "ana"]));
  });

  it("hands its work a ring that never fetches on its own, and runs it again once what it lacked is fetched", async () => {
    const asked: string[][] = [];
    let runs = 0;
    const opened = await withKeys({
      keys: {
        heldAllOf: async (persons) => {
          asked.push([...persons]);
          return new Map();
        },
      },
      events: [],
      run: async (keys) => {
        runs += 1;
        return keys.forOpen("zed", "f");
      },
    });
    expect(opened).toBeNull();
    expect(runs).toBe(2);
    expect(asked).toEqual([["zed"]]);
  });
});
