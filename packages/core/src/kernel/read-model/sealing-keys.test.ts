import { describe, expect, it } from "vitest";
import { pendingEvent } from "../../adapter/testing/fixtures.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import type { EventPayloadArgs } from "../../modules/payload.ts";
import type { Registry } from "../../modules/registry.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { appStorage } from "../events/app-event-store.ts";
import { createDisposableKey, type PersonalKey } from "../personal-data/crypto.ts";
import type { CategoryKey } from "../personal-data/wrapped-keys.ts";
import { createPersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { batchPersons } from "../projection/runner.ts";
import { eachPerson } from "../test-support.ts";
import { createSealingKeyRing, KeysMissingError } from "./sealing-keys.ts";

const key = async (retained = false): Promise<PersonalKey> => ({
  ...(await createDisposableKey()),
  retained,
});

const held = (category: string, of: PersonalKey, retainedSince: string | null = null) =>
  ({ category, key: of, retainedSince }) satisfies CategoryKey;

describe("createSealingKeyRing", () => {
  it("writes under the key in force, else the latest kept, else a disposable one", async () => {
    const inForce = await key();
    const older = await key(true);
    const newer = await key(true);
    const fetched: string[] = [];
    const ring = createSealingKeyRing({
      keys: eachPerson(async (person) => {
        fetched.push(person);
        if (person === "ana")
          return [
            held("invoices", newer, "2026-02-01"),
            held("invoices", older, "2026-01-01"),
            held("default", inForce),
          ];
        if (person === "bo") return [held("invoices", older, "2026-01-01")];
        return [];
      }),
      fetching: true,
    });
    expect(await ring.forWrite("ana", "default", null)).toBe(inForce);
    expect(await ring.forWrite("ana", "invoices", null)).toBe(newer);
    expect(await ring.forWrite("bo", "invoices", null)).toBe(older);
    const disposable = await ring.forWrite("cy", "invoices", null);
    expect(disposable).not.toBe(inForce);
    expect(await ring.forWrite(null, "default", null)).toBe(disposable);
    expect(await ring.forOpen("ana", older.fingerprint)).toBe(older);
    expect(await ring.forOpen("ana", "gone")).toBeNull();
    expect(fetched).toEqual(["ana", "bo", "cy"]);
  });

  it("throws for a person it has not fetched, naming them, until it fetches them", async () => {
    const inForce = await key();
    const ring = createSealingKeyRing({
      keys: eachPerson(() => [held("default", inForce)]),
      fetching: false,
    });
    await expect(ring.forWrite("ana", "default", null)).rejects.toEqual(
      new KeysMissingError(["ana"]),
    );
    await expect(ring.forOpen("ana", inForce.fingerprint)).rejects.toBeInstanceOf(KeysMissingError);
    await ring.fetch(["ana", "ana"]);
    expect(await ring.forWrite("ana", "default", null)).toBe(inForce);
    expect(await ring.forOpen("ana", inForce.fingerprint)).toBe(inForce);
  });
});

describe("the key an event opened under", () => {
  const registry = {
    aggregates: {
      customer: {
        events: {
          customerRegistered: {
            payload: ({ z, personal }: EventPayloadArgs) =>
              z.object({ email: personal(z.string()) }),
            evolve: () => ({}),
          },
        },
        commands: {},
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  } as unknown as Registry;

  it("writes a value of the event's person under the key the event was opened under, even with a key in force, and another person's under theirs", async () => {
    const storage = appStorage({
      storage: await memory().createStorage(),
      aggregates: buildAggregates({ registry, ports: {} }),
      processes: { byName: {} },
      wrapping: createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }),
    });
    await storage.eventStore.append({
      aggregateType: "customer",
      aggregateId: "ana",
      expectedVersion: 0,
      events: [
        pendingEvent({
          aggregateType: "customer",
          aggregateId: "ana",
          version: 1,
          type: "CustomerRegistered",
          payload: { email: "a@x" },
        }),
      ],
    });
    const [event] = await storage.eventStore.readAll({ afterPosition: 0, limit: 10 });
    const first = await storage.personalKeys.get("ana", "default");
    if (event === undefined || first === null) throw new Error("no event or key");
    await storage.personalKeys.retain("ana", first.fingerprint, {
      since: "2026-01-01T00:00:00.000Z",
      lastActiveAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = await storage.personalKeys.create("ana", "default");
    const bo = await storage.personalKeys.create("bo", "default");
    const ring = createSealingKeyRing({ keys: storage.personalKeys, fetching: true });
    expect((await ring.forWrite("ana", "default", event)).fingerprint).toBe(first.fingerprint);
    expect((await ring.forWrite("ana", "default", null)).fingerprint).toBe(newer.fingerprint);
    expect((await ring.forWrite("bo", "default", event)).fingerprint).toBe(bo.fingerprint);
    expect(await ring.kept("ana", "default")).toBe(true);
    expect(await ring.kept("ana", "invoices")).toBe(false);
    expect(await ring.kept("bo", "default")).toBe(false);
    expect(batchPersons([event, event])).toEqual(["ana"]);
  });
});

describe("the latest key kept", () => {
  it("writes under the key a forgetting kept last, whatever order the store lists them in", async () => {
    const older = await key(true);
    const newer = await key(true);
    for (const listed of [
      [held("invoices", older, "2026-01-01"), held("invoices", newer, "2026-02-01")],
      [held("invoices", newer, "2026-02-01"), held("invoices", older, "2026-01-01")],
    ]) {
      const ring = createSealingKeyRing({ keys: eachPerson(() => listed), fetching: true });
      expect(await ring.forWrite("ana", "invoices", null)).toBe(newer);
      expect(await ring.kept("ana", "invoices")).toBe(true);
    }
    const mixed = createSealingKeyRing({
      keys: eachPerson(() => [held("default", older, "2026-01-01"), held("invoices", newer)]),
      fetching: true,
    });
    expect(await mixed.kept("ana", "invoices")).toBe(false);
    expect(await mixed.kept("ana", "default")).toBe(true);
  });

  it("names the error that says keys are missing", () => {
    const error = new KeysMissingError(["ana"]);
    expect(error.name).toBe("KeysMissingError");
    expect(error.message).toBe("Keys of persons a read model writes or reads were not fetched yet");
    expect(error.persons).toEqual(["ana"]);
  });
});

describe("a ring's reads", () => {
  it("fetches only the persons it does not hold yet, in one read, and names the category of a key it holds", async () => {
    const inForce = await key();
    const asked: string[][] = [];
    const ring = createSealingKeyRing({
      keys: {
        heldAllOf: async (persons) => {
          asked.push([...persons]);
          return new Map(
            persons.filter((p) => p !== "cy").map((p) => [p, [held("invoices", inForce)]]),
          );
        },
      },
      fetching: false,
    });
    await ring.fetch(["ana", "bo", "ana"]);
    await ring.fetch(["ana", "cy"]);
    await ring.fetch(["bo"]);
    expect(asked).toEqual([["ana", "bo"], ["cy"]]);
    expect(await ring.categoryOf("ana", inForce.fingerprint)).toBe("invoices");
    expect(await ring.categoryOf("ana", "other")).toBeNull();
    expect(await ring.categoryOf("cy", inForce.fingerprint)).toBeNull();
  });
});
