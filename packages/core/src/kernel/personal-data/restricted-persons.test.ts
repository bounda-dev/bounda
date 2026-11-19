import { describe, expect, it } from "vitest";
import type { Adapter } from "../../adapter/adapter.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { eventMark, streamMarkOf } from "../read-model/stream-marks.ts";
import { tracer } from "../telemetry.ts";
import {
  createRestrictedPersonsSubscriber,
  restrictedPersonsHosts,
  restrictedPersonsSubscriberName,
} from "./restricted-persons.ts";

describe("restrictedPersonsSubscriberName", () => {
  it("is named after the read model it writes through", () => {
    expect(restrictedPersonsSubscriberName("orders")).toBe("restrictions:orders");
  });
});

describe("restrictedPersonsHosts", () => {
  it("picks per database the first read model by name that holds a field marked .person()", () => {
    const first: Adapter = memory();
    const second: Adapter = memory();
    const readModel = (name: string, person: boolean) => ({
      name,
      storage: {} as never,
      personalData: person ? ({} as never) : null,
    });
    const on: Record<string, Adapter> = { c: first, b: first, a: first, d: second, e: second };
    expect(
      restrictedPersonsHosts({
        readModels: [
          readModel("c", true),
          readModel("b", true),
          readModel("a", false),
          readModel("e", true),
          readModel("d", true),
        ],
        adapterOf: (name) => on[name] as Adapter,
      }).map(({ name }) => name),
    ).toEqual(["b", "d"]);
  });
});

describe("createRestrictedPersonsSubscriber", () => {
  it("is given work by the changes of restrictions alone", () => {
    const subscriber = createRestrictedPersonsSubscriber({
      tracer,
      readModel: { name: "orders", storage: {} as never },
      logger: silentLogger,
      errorText: "omit",
    });
    const event = (aggregateType: string, type: string) =>
      ({ aggregateType, type }) as unknown as StoredEvent;
    expect(
      [
        event("bounda", "ProcessingRestricted"),
        event("bounda", "ProcessingRestrictionLifted"),
        event("bounda", "PersonalDataForgotten"),
        event("order", "ProcessingRestricted"),
      ].map((each) => subscriber.handles?.(each)),
    ).toEqual([true, true, false, false]);
  });
});

describe("the checkpoint of a database's copy of who is restricted", () => {
  const restricted = {
    id: "e-1",
    position: 1,
    aggregateType: "bounda",
    aggregateId: "ana",
    type: "ProcessingRestricted",
    payload: { personId: "ana", restrictions: [{ ground: "legal-claims", categories: null }] },
  } as unknown as StoredEvent;

  it.each([
    [false, []],
    [true, [{ subscriber: streamMarkOf("restrictions:orders"), position: eventMark("e-1") }]],
  ])(
    "is marked with the event it stands at only in a database of read models alone (%s)",
    async (marked, marks) => {
      const storage = await memory().createReadModel<Record<string, unknown>>({
        name: "orders",
        fields: { orderId: f.string().primaryKey(), customerId: f.string().person() },
        logger: silentLogger,
      });
      const subscriber = createRestrictedPersonsSubscriber({
        tracer,
        readModel: { name: "orders", storage },
        logger: silentLogger,
        errorText: "omit",
        ...(marked ? { marked } : {}),
      });
      await subscriber.deliver({
        read: async (after) => (after < 1 ? [restricted] : []),
        batchSize: 10,
        wait: true,
      });
      expect(await storage.checkpointStore.list()).toEqual([
        { subscriber: "restrictions:orders", position: 1 },
        ...marks,
      ]);
    },
  );
});
