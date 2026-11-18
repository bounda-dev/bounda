import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import type { CommandPayloadArgs, EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { createTestApp } from "../../testing/index.ts";
import { isSealed } from "./crypto.ts";

interface Builders {
  readonly [name: string]: (payload?: unknown) => unknown;
}

interface Delivery {
  readonly courierId: string | null;
  readonly courierPhone: string | null;
}

// The step that fails quotes what the instance's state holds of the courier, as a careless one does.
const registry = {
  aggregates: {
    order: {
      events: {
        orderPlaced: {
          payload: ({ z, person, personal, notPersonal }: EventPayloadArgs) =>
            z.object({
              orderId: notPersonal(z.string()),
              customerId: person(z.string()),
              email: personal(z.email()),
            }),
          evolve: () => ({}),
        },
        orderPacked: {
          payload: ({ z, person, personal, notPersonal }: EventPayloadArgs) =>
            z.object({
              orderId: notPersonal(z.string()),
              customerId: person(z.string()),
              address: personal(z.string()),
            }),
          evolve: () => ({}),
        },
        orderDelivered: {
          payload: ({ z }: EventPayloadArgs) => z.object({}),
          evolve: () => ({}),
        },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                orderId: notPersonal(z.string()),
                customerId: notPersonal(z.string()),
                email: notPersonal(z.email()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string; email: string } };
              events: Builders;
            }) => [events.orderPlaced?.(command.payload)],
          },
        },
        packOrder: {
          module: {
            payload: ({ z, notPersonal }: CommandPayloadArgs) =>
              z.object({
                orderId: notPersonal(z.string()),
                customerId: notPersonal(z.string()),
                address: notPersonal(z.string()),
              }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { customerId: string; address: string } };
              events: Builders;
            }) => [events.orderPacked?.(command.payload)],
          },
        },
      },
      policies: {},
      processes: {
        delivery: {
          module: {
            config: ({
              events,
            }: {
              events: { order: { OrderPlaced: string; OrderDelivered: string } };
            }) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderDelivered],
              timeout: "48h",
            }),
            state: ({ z, person, personal }: EventPayloadArgs) =>
              z.object({
                courierId: person(z.string()).nullable().default(null),
                courierPhone: personal(z.string()).nullable().default(null),
              }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: () => ({ courierId: "k-1", courierPhone: "+34 600 000 000" }),
              },
              orderPacked: {
                handler: ({ state }: { state: Delivery }) => {
                  throw new ValidationError(
                    `courier ${state.courierPhone ?? "nobody"} unreachable`,
                    [],
                  );
                },
              },
            },
          },
        },
      },
    },
  },
  readModels: {},
} as unknown as Registry;

const setup = async () => {
  const adapter = memory();
  const storage = await adapter.createStorage();
  const { app } = await createTestApp({
    registry,
    adapter,
    logger: silentLogger,
    config: { runtime: { processes: { retry: { strategy: "none" } } } },
  });
  await app.commands.placeOrder?.({ orderId: "o-1", customerId: "c-1", email: "ana@example.com" });
  await app.commands.packOrder?.({ orderId: "o-1", customerId: "c-1", address: "Gran Vía 1" });
  await app.runUntilIdle();
  const [letter] = await storage.deadLetterStore.list({ kind: "process" });
  if (letter === undefined) throw new Error("the step did not fail");
  return { app, storage, letter };
};

describe("a process letter whose step read the state of another person than its event's", () => {
  it("names the state's person beside the event's, and seals the text under both", async () => {
    const { app, letter } = await setup();
    expect(letter).toMatchObject({ person: "c-1", statePerson: "k-1" });
    expect(letter.errorMessage).toMatchObject({ $personal: { person: "k-1" } });
    expect(isSealed(letter.errorStack)).toBe(true);
    expect(JSON.stringify(letter)).not.toContain("600 000");
    expect((await app.deadLetters.get(letter.id))?.errorMessage).toBe(
      "courier +34 600 000 000 unreachable",
    );
    await app.stop();
  });

  it("reads its text as null once the state's person is forgotten, and keeps the letter", async () => {
    const { app, storage, letter } = await setup();
    await app.forget("k-1");
    expect(await storage.deadLetterStore.get(letter.id)).not.toBeNull();
    expect((await app.deadLetters.get(letter.id))?.errorMessage).toBeNull();
    await app.stop();
  });

  it("holds its text back from the export of either person, which it may quote the other's data to", async () => {
    const { app, letter } = await setup();
    const withheld = ["errorMessage", "errorStack"].map((field) => ({
      field,
      reason: "rights-of-others",
      article: "15(4)",
    }));
    for (const person of ["c-1", "k-1"]) {
      const exported = await app.exportPersonalData(person);
      expect(exported.deadLetters).toEqual([
        expect.objectContaining({ id: letter.id, errorMessage: null, errorStack: null, withheld }),
      ]);
      expect(JSON.stringify(exported)).not.toContain("+34 600 000 000 unreachable");
      expect((await app.exportPersonalData(person, { includeWithheld: true })).deadLetters).toEqual(
        [
          expect.objectContaining({
            id: letter.id,
            errorMessage: "courier +34 600 000 000 unreachable",
            withheld,
          }),
        ],
      );
    }
    await app.stop();
  });

  it("keeps it sealed while the state's person is restricted", async () => {
    const { app, letter } = await setup();
    await app.restrict("k-1", { ground: "objection-pending", categories: ["default"] });
    expect(await app.deadLetters.get(letter.id)).toMatchObject({
      errorMessage: null,
      restricted: true,
    });
    await app.stop();
  });

  it("seals for good the text that quotes a value of the state's person redacted", async () => {
    const { app, storage, letter } = await setup();
    const events = (await app.exportPersonalData("k-1")).events.flatMap((event) =>
      Object.values(event.data).includes("+34 600 000 000")
        ? [
            {
              aggregateType: event.aggregateType,
              aggregateId: event.aggregateId,
              type: event.type,
              id: event.id,
              fields: ["courierPhone"],
            },
          ]
        : [],
    );
    expect(events).not.toEqual([]);
    await app.redact("k-1", { events });
    const stored = await storage.deadLetterStore.get(letter.id);
    expect(stored).toMatchObject({ person: "c-1", statePerson: "k-1" });
    expect((await app.deadLetters.get(letter.id))?.errorMessage).toBeNull();
    await app.stop();
  });
});
