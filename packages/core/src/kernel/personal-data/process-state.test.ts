import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { ValidationError } from "../../contracts/errors.ts";
import { newStoredKey, openedKey } from "../test-support.ts";
import { isSealed, unseal } from "./crypto.ts";
import type { PersonalMarks } from "./marks.ts";
import {
  checkStatePerson,
  lifecycleStateOf,
  sealLifecycleEvent,
  sealState,
  statePersonOf,
} from "./process-state.ts";

const byField: PersonalMarks = {
  person: "customerId",
  fields: ["email", "phone"],
  categories: { email: "profile", phone: DEFAULT_PERSONAL_CATEGORY },
};
const byInstance: PersonalMarks = {
  person: null,
  fields: ["email"],
  categories: { email: DEFAULT_PERSONAL_CATEGORY },
};

describe("lifecycleStateOf", () => {
  it("is the state a lifecycle event carries, and null for one that carries none", () => {
    expect(lifecycleStateOf({ state: { email: "a" }, eventId: "e-1" })).toEqual({ email: "a" });
    expect(lifecycleStateOf({ eventId: "e-1" })).toBeNull();
    expect(lifecycleStateOf({ state: "a" })).toBeNull();
    expect(lifecycleStateOf(null)).toBeNull();
  });
});

describe("statePersonOf", () => {
  it("is the person field's id, or the instance's id when none is marked", () => {
    const state = { customerId: "c-1", email: "a" };
    expect(statePersonOf({ marks: byField, state, instanceId: "s-1" })).toBe("c-1");
    expect(statePersonOf({ marks: byField, state: { customerId: 7 }, instanceId: "s-1" })).toBe(
      "7",
    );
    expect(statePersonOf({ marks: byInstance, state, instanceId: "s-1" })).toBe("s-1");
  });

  it("is null for a state that marks no person field while it holds no personal value", () => {
    expect(statePersonOf({ marks: byInstance, state: { email: null }, instanceId: "s-1" })).toBe(
      null,
    );
  });

  it("is null while the person field holds no id", () => {
    for (const customerId of [null, undefined, "", true]) {
      expect(
        statePersonOf({ marks: byField, state: { customerId }, instanceId: "s-1" }),
      ).toBeNull();
    }
  });
});

describe("checkStatePerson", () => {
  const check =
    (state: Record<string, unknown>, marks = byField) =>
    () =>
      checkStatePerson({ process: "signup.onboarding", marks, state, instanceId: "s-1" });

  it("lets a state through that names its person, or holds no personal value", () => {
    expect(check({ customerId: "c-1", email: "a" })).not.toThrow();
    expect(check({ customerId: null, email: null, phone: undefined })).not.toThrow();
    expect(check({ email: "a" }, byInstance)).not.toThrow();
  });

  it("refuses a personal value with nobody named to seal it under", () => {
    expect(check({ customerId: null, phone: "555" })).toThrow(
      new ValidationError(
        'Process signup.onboarding holds personal data for s-1 and names no person in "customerId"',
        [{ path: ["customerId"], message: "Expected a non-empty string" }],
      ),
    );
  });
});

describe("sealState", () => {
  it("seals each personal value under the person's key, keeping nulls and what is sealed already", async () => {
    const key = await openedKey(await newStoredKey());
    const persons: string[] = [];
    const sealOnce = async (state: Record<string, unknown>) =>
      sealState({
        marks: byField,
        state,
        person: "c-1",
        key: async (person, category) => {
          persons.push(`${person}:${category}`);
          return key;
        },
      });
    const sealed = await sealOnce({ customerId: "c-1", email: "a@b.c", phone: null, nudges: 2 });

    expect(sealed.customerId).toBe("c-1");
    expect(sealed.phone).toBeNull();
    expect(sealed.nudges).toBe(2);
    expect(isSealed(sealed.email)).toBe(true);
    expect(isSealed(sealed.email) && (await unseal({ key, sealed: sealed.email }))).toBe("a@b.c");
    expect(persons).toEqual(["c-1:profile"]);
    expect(isSealed(sealed.email) && sealed.email.$personal.category).toBe("profile");
    expect(await sealOnce({ ...sealed, phone: "555" })).toMatchObject({ email: sealed.email });
  });
});

describe("sealLifecycleEvent", () => {
  const sealing = async (payload: unknown) => {
    const key = await openedKey(await newStoredKey());
    const event = { aggregateId: "s-1", payload, person: null };
    return {
      event,
      sealed: await sealLifecycleEvent({
        process: "signup.onboarding",
        marks: byField,
        event,
        key: async () => key,
      }),
    };
  };

  it("seals the state's personal fields and names whom the state names", async () => {
    const { sealed } = await sealing({
      state: { customerId: "c-1", email: "a@b.c" },
      eventId: "e",
    });
    const payload = sealed.payload as { state: Record<string, unknown>; eventId: string };
    expect(sealed.person).toBe("c-1");
    expect(payload.eventId).toBe("e");
    expect(payload.state.customerId).toBe("c-1");
    expect(isSealed(payload.state.email)).toBe(true);
  });

  it("leaves an event as it is when it carries no state or its state names nobody", async () => {
    for (const payload of [{ eventId: "e" }, { state: { customerId: null, email: null } }]) {
      const { event, sealed } = await sealing(payload);
      expect(sealed).toBe(event);
    }
  });

  it("refuses a personal value with nobody named", async () => {
    await expect(sealing({ state: { customerId: null, email: "a@b.c" } })).rejects.toThrow(
      ValidationError,
    );
  });
});
