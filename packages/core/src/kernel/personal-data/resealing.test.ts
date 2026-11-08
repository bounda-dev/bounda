import { describe, expect, it } from "vitest";
import type { StoredEvent } from "../../contracts/event.ts";
import { memory } from "../../memory/index.ts";
import { BOUNDA_AGGREGATE, PERSONAL_DATA_FORGOTTEN_EVENT } from "../../modules/bounda-events.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";
import { generatePersonalKey, importPersonalKey, isSealed, seal, unseal } from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";
import {
  createResealKeys,
  marksFingerprint,
  planEventReseal,
  planPayloadReseal,
  type ResealPlanOf,
} from "./resealing.ts";

interface Marked {
  readonly events?: Readonly<Record<string, PersonalMarks | null>>;
  readonly commands?: Readonly<Record<string, PersonalMarks | null>>;
  readonly process?: PersonalMarks | null;
}

const runtimes = ({ events = {}, commands = {}, process = null }: Marked) => {
  const eventsByType = Object.fromEntries(
    Object.entries(events).map(([type, personal]) => [type, { type, personal }]),
  );
  const commandRuntimes = Object.fromEntries(
    Object.entries(commands).map(([type, personal]) => [type, { type, personal }]),
  );
  const aggregates = {
    byName: { customer: { name: "customer", eventsByType, commands: commandRuntimes } },
    commandsByType: {},
  } as unknown as AggregatesRuntime;
  const onboarding = { name: "signup.onboarding", personal: process };
  const processes = {
    all: [onboarding],
    byName: { "signup.onboarding": onboarding },
  } as unknown as Pick<ProcessesRuntime, "all" | "byName">;
  return { aggregates, processes };
};

const event = (overrides: Partial<StoredEvent>): StoredEvent => ({
  id: "e-1",
  aggregateType: "customer",
  aggregateId: "c-1",
  version: 1,
  position: 5,
  type: "CustomerRegistered",
  payload: {},
  timestamp: "2026-01-01T00:00:00.000Z",
  metadata: {
    correlationId: "c",
    causationId: "c",
    commandId: "c",
    depth: 0,
    schemaVersion: 1,
    system: false,
  },
  person: null,
  ...overrides,
});

const byAggregate: PersonalMarks = { person: null, fields: ["email"] };
const byField: PersonalMarks = { person: "customerId", fields: ["address"] };

const sealedWith = async <Value>(plan: ResealPlanOf<Value>) => {
  if (plan === null || plan === "unsealable") throw new Error(`no plan: ${String(plan)}`);
  const key = await importPersonalKey(await generatePersonalKey());
  return { person: plan.person, key, value: await plan.seal(key) };
};

describe("marksFingerprint", () => {
  it("is null when nothing is marked, and names each set of marks apart, whatever their order", () => {
    expect(marksFingerprint(runtimes({ events: { CustomerRegistered: null } }))).toBeNull();
    const one = marksFingerprint(
      runtimes({ events: { CustomerRegistered: { person: null, fields: ["email", "name"] } } }),
    );
    expect(one).toEqual(
      marksFingerprint(
        runtimes({ events: { CustomerRegistered: { person: null, fields: ["name", "email"] } } }),
      ),
    );
    const others = [
      runtimes({ events: { CustomerRegistered: { person: null, fields: ["email"] } } }),
      runtimes({ events: { CustomerRegistered: { person: "email", fields: ["name"] } } }),
      runtimes({ commands: { CustomerRegistered: { person: null, fields: ["email", "name"] } } }),
      runtimes({ process: { person: null, fields: ["email", "name"] } }),
    ].map(marksFingerprint);
    expect(new Set([one, ...others]).size).toBe(5);
  });
});

describe("planEventReseal", () => {
  const { aggregates, processes } = runtimes({
    events: { CustomerRegistered: byAggregate, OrderPlaced: byField, CustomerNoted: null },
    process: { person: "customerId", fields: ["email"] },
  });
  const plan = (overrides: Partial<StoredEvent>) =>
    planEventReseal({ event: event(overrides), aggregates, processes });

  it("seals what a domain event holds in the clear under the person its marks name, who becomes its person", async () => {
    const { person, key, value } = await sealedWith(
      plan({ payload: { email: "ada@example.com", name: "Ada" } }),
    );
    expect(person).toBe("c-1");
    const { email, name } = value as { email: unknown; name: unknown };
    expect(name).toBe("Ada");
    expect(isSealed(email)).toBe(true);
    expect(await unseal({ key, sealed: email as never })).toBe("ada@example.com");

    const ordered = await sealedWith(
      plan({ type: "OrderPlaced", payload: { customerId: 7, address: "Bilbao" } }),
    );
    expect(ordered.person).toBe("7");
  });

  it("keeps what is sealed already and seals the rest, and seals a null as the event store does", async () => {
    const key = await importPersonalKey(await generatePersonalKey());
    const address = await seal({ key, person: "c-2", value: "Bilbao" });
    const partly = planEventReseal({
      event: event({ payload: { email: null }, person: null }),
      aggregates: runtimes({
        events: { CustomerRegistered: { person: null, fields: ["email", "address"] } },
      }).aggregates,
      processes,
    });
    const { value } = await sealedWith(partly);
    expect(isSealed((value as { email: unknown }).email)).toBe(true);
    const kept = await sealedWith(
      planEventReseal({
        event: event({ payload: { email: "a", address }, person: "c-1" }),
        aggregates: runtimes({
          events: { CustomerRegistered: { person: null, fields: ["email", "address"] } },
        }).aggregates,
        processes,
      }),
    );
    expect((kept.value as { address: unknown }).address).toEqual(address);
  });

  it("names the person of an event with nothing in the clear that names nobody yet, and leaves the rest alone", async () => {
    const named = await sealedWith(plan({ payload: { name: "Ada" } }));
    expect(named).toMatchObject({ person: "c-1", value: { name: "Ada" } });
    expect(plan({ payload: { name: "Ada" }, person: "c-1" })).toBeNull();
    expect(plan({ type: "CustomerNoted", payload: { email: "a" } })).toBeNull();
    expect(plan({ type: "Unknown", payload: { email: "a" } })).toBeNull();
    expect(plan({ aggregateType: "unknown", payload: { email: "a" } })).toBeNull();
    expect(plan({ payload: "not an object" })).toBeNull();
    expect(plan({ type: "OrderPlaced", payload: { customerId: "" } })).toBeNull();
  });

  it("leaves unsealable what names nobody to seal it under, or another person than the event", () => {
    expect(plan({ type: "OrderPlaced", payload: { customerId: "", address: "Bilbao" } })).toBe(
      "unsealable",
    );
    expect(plan({ type: "OrderPlaced", payload: { address: "Bilbao" } })).toBe("unsealable");
    expect(plan({ payload: { email: "a" }, person: "c-9" })).toBe("unsealable");
    expect(plan({ payload: { name: "Ada" }, person: "c-9" })).toBeNull();
  });

  it("seals the state a process lifecycle event carries under whom it names", async () => {
    const lifecycle = (state: unknown, person: string | null = null) =>
      planEventReseal({
        event: event({
          aggregateType: "process:signup.onboarding",
          aggregateId: "s-1",
          type: "ProcessHandled",
          payload: { step: "x", state },
          person,
        }),
        aggregates,
        processes,
      });
    const { person, value } = await sealedWith(
      lifecycle({ customerId: "c-1", email: "ada@example.com", nudges: 1 }),
    );
    expect(person).toBe("c-1");
    const { state, step } = value as { state: Record<string, unknown>; step: string };
    expect(step).toBe("x");
    expect(state.nudges).toBe(1);
    expect(isSealed(state.email)).toBe(true);
    expect(lifecycle({ customerId: null, email: null })).toBeNull();
    expect(lifecycle({ customerId: null, email: "ada@example.com" })).toBe("unsealable");
    expect(lifecycle({ customerId: "c-1", email: null }, "c-1")).toBeNull();
    expect(
      planEventReseal({
        event: event({
          aggregateType: "process:signup.onboarding",
          type: "ProcessCompleted",
          payload: { reason: "completed" },
        }),
        aggregates,
        processes,
      }),
    ).toBeNull();
    const byInstance = runtimes({ process: { person: null, fields: ["email"] } });
    const instance = await sealedWith(
      planEventReseal({
        event: event({
          aggregateType: "process:signup.onboarding",
          aggregateId: "s-1",
          type: "ProcessStarted",
          payload: { state: { email: "a" } },
        }),
        ...byInstance,
      }),
    );
    expect(instance.person).toBe("s-1");
  });
});

describe("planPayloadReseal", () => {
  it("seals a command's marked fields in the clear under whom its marks name", async () => {
    const { person, value } = await sealedWith(
      planPayloadReseal({
        marks: byField,
        payload: { customerId: "c-2", address: "Bilbao" },
        aggregateId: "o-1",
      }),
    );
    expect(person).toBe("c-2");
    expect(isSealed(value.address)).toBe(true);
    expect(value.customerId).toBe("c-2");
    const byId = await sealedWith(
      planPayloadReseal({ marks: byAggregate, payload: { email: "a" }, aggregateId: "c-1" }),
    );
    expect(byId.person).toBe("c-1");
  });

  it("has nothing to seal without a value in the clear, and nobody to seal under without a person", () => {
    expect(
      planPayloadReseal({ marks: null, payload: { email: "a" }, aggregateId: "c-1" }),
    ).toBeNull();
    expect(planPayloadReseal({ marks: byAggregate, payload: 1, aggregateId: "c-1" })).toBeNull();
    expect(planPayloadReseal({ marks: byAggregate, payload: {}, aggregateId: "c-1" })).toBeNull();
    expect(
      planPayloadReseal({ marks: byField, payload: { address: "Bilbao" }, aggregateId: "o-1" }),
    ).toBe("unsealable");
  });
});

describe("createResealKeys", () => {
  const forgotten = (person: string, version: number) => ({
    id: `forgotten-${person}-${version}`,
    aggregateType: BOUNDA_AGGREGATE,
    aggregateId: person,
    version,
    type: PERSONAL_DATA_FORGOTTEN_EVENT,
    payload: { personId: person },
    timestamp: "2026-01-02T00:00:00.000Z",
    metadata: {
      correlationId: "c",
      causationId: "c",
      commandId: "c",
      depth: 0,
      schemaVersion: 1,
      system: true,
    },
    person,
  });

  const setup = async () => {
    const storage = await memory().createStorage();
    for (let position = 1; position <= 3; position += 1) {
      await storage.eventStore.append({
        aggregateType: "filler",
        aggregateId: String(position),
        expectedVersion: 0,
        events: [
          {
            ...forgotten("x", 1),
            id: `f-${position}`,
            aggregateType: "filler",
            aggregateId: String(position),
          },
        ],
      });
    }
    // Forgotten at position 4, after the events at 1 to 3.
    await storage.eventStore.append({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: "gone",
      expectedVersion: 0,
      events: [forgotten("gone", 1)],
    });
    const back = await storage.personalKeys.add("back", await generatePersonalKey());
    await storage.eventStore.append({
      aggregateType: BOUNDA_AGGREGATE,
      aggregateId: "back",
      expectedVersion: 0,
      events: [forgotten("back", 1)],
    });
    const kept = await storage.personalKeys.add("kept", await generatePersonalKey());
    const keys = createResealKeys({ transaction: storage, keys: storage.personalKeys });
    return { storage, keys, back, kept };
  };

  it("discards a key for what an event held of a person forgotten after it, and creates one otherwise", async () => {
    const { storage, keys, back } = await setup();
    expect(await keys.event("gone", 3)).toMatchObject({ discarded: true });
    expect(await storage.personalKeys.get("gone")).toBeNull();
    const again = await keys.event("gone", 3);
    expect(again.key).toBe((await keys.event("gone", 1)).key);
    expect(await keys.event("back", 6)).toMatchObject({
      discarded: false,
      key: { fingerprint: back.fingerprint },
    });
    const fresh = await keys.event("new", 1);
    expect(fresh.discarded).toBe(false);
    expect((await storage.personalKeys.get("new"))?.fingerprint).toBe(fresh.key.fingerprint);
    expect((await keys.event("new", 2)).key).toBe(fresh.key);
  });

  it("seals a payload under the key the person holds unless forgotten after it was filed, and creates none for a forgotten person", async () => {
    const { storage, keys, back, kept } = await setup();
    expect(await keys.payload("kept", null)).toMatchObject({
      discarded: false,
      key: { fingerprint: kept.fingerprint },
    });
    expect(await keys.payload("back", "2026-01-01T00:00:00.000Z")).toMatchObject({
      discarded: true,
    });
    expect(await keys.payload("back", "2026-01-03T00:00:00.000Z")).toMatchObject({
      discarded: false,
      key: { fingerprint: back.fingerprint },
    });
    expect(await keys.payload("back", null)).toMatchObject({ discarded: false });
    expect(await keys.payload("gone", null)).toMatchObject({ discarded: true });
    expect(await storage.personalKeys.get("gone")).toBeNull();
    expect(await keys.payload("new", null)).toMatchObject({ discarded: false });
    expect(await storage.personalKeys.get("new")).not.toBeNull();
  });

  it("seals the text of an error under the key the person holds, never a new one", async () => {
    const { storage, keys, kept } = await setup();
    expect(await keys.errorText("kept", "2026-01-01T00:00:00.000Z")).toMatchObject({
      discarded: false,
      key: { fingerprint: kept.fingerprint },
    });
    expect(await keys.errorText("back", "2026-01-01T00:00:00.000Z")).toMatchObject({
      discarded: true,
    });
    expect(await keys.errorText("back", "2026-01-03T00:00:00.000Z")).toMatchObject({
      discarded: false,
    });
    expect(await keys.errorText("new", "2026-01-01T00:00:00.000Z")).toMatchObject({
      discarded: true,
    });
    expect(await storage.personalKeys.get("new")).toBeNull();
  });
});
