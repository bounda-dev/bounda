import { describe, expect, it } from "vitest";
import { ProcessingRestrictedError } from "../../contracts/errors.ts";
import { pendingEvent } from "../testing/fixtures.ts";
import {
  appendPersonsOf,
  checkAppend,
  ForgottenSinceLoadError,
  type KeyRead,
  type RestrictionRead,
} from "./append-checks.ts";
import type { AppendArgs } from "./event-store.ts";
import type { KeyedPerson } from "./personal-key-store.ts";

const append = (names: Pick<AppendArgs, "persons" | "touches" | "seals">): AppendArgs => ({
  aggregateType: "order",
  aggregateId: "1",
  expectedVersion: 3,
  events: [pendingEvent({ aggregateId: "1", version: 4 })],
  ...names,
});

const held = (category = "default"): KeyRead => ({ state: "held", category });
const retainedKey = (category = "default"): KeyRead => ({ state: "retained", category });

describe("appendPersonsOf", () => {
  it("names each person once: those with a key, read or sealed under, and those whose restrictions a touch or a seal reads", () => {
    expect(appendPersonsOf(append({}))).toEqual({ keyed: [], restricted: [] });
    expect(
      appendPersonsOf(
        append({
          persons: [
            { person: "c-1", fingerprint: "f-1" },
            { person: "c-1", fingerprint: "f-2" },
            { person: "c-2", fingerprint: null },
          ],
        }),
      ),
    ).toEqual({ keyed: ["c-1"], restricted: [] });
    expect(
      appendPersonsOf(
        append({
          persons: [{ person: "c-1", fingerprint: "f-1" }],
          seals: [{ person: "c-4", fingerprint: "f-4" }],
          touches: ["c-3", "c-3", "c-1"],
        }),
      ),
    ).toEqual({ keyed: ["c-1", "c-4"], restricted: ["c-3", "c-1", "c-4"] });
  });
});

describe("checkAppend", () => {
  it("checks nothing an append does not name", () => {
    const whole = () => [{ category: null }];
    expect(() =>
      checkAppend({ args: append({}), keyOf: () => null, restrictionsOf: whole }),
    ).not.toThrow();
    expect(() =>
      checkAppend({
        args: append({
          persons: [{ person: "c-1", fingerprint: null }],
          seals: [{ person: "c-1", fingerprint: null }],
        }),
        keyOf: () => null,
        restrictionsOf: whole,
      }),
    ).not.toThrow();
  });

  it("names the person and the stream of an append whose key is gone", () => {
    const refused = (() => {
      try {
        checkAppend({
          args: append({ persons: [{ person: "c-1", fingerprint: "f-1" }] }),
          keyOf: () => null,
          restrictionsOf: () => [],
        });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(refused).toBeInstanceOf(ForgottenSinceLoadError);
    expect(refused).toMatchObject({
      personId: "c-1",
      streamId: "order:1",
      expectedVersion: 3,
      actualVersion: 3,
      message: "Person c-1 was forgotten since order:1 was loaded at version 3",
    });
  });

  it("lets a key read in force through while it is in force, and one read retained while it is kept at all, restricted or not", () => {
    const check = (read: KeyedPerson, key: KeyRead | null) => () =>
      checkAppend({
        args: append({ persons: [read] }),
        keyOf: (person, fingerprint) => (person === "c-1" && fingerprint === "f-1" ? key : null),
        restrictionsOf: () => [{ category: null }],
      });
    const inForce = { person: "c-1", fingerprint: "f-1" };
    const retained = { ...inForce, retained: true as const };
    expect(check(inForce, held())).not.toThrow();
    expect(check(inForce, retainedKey())).toThrow(ForgottenSinceLoadError);
    expect(check(inForce, null)).toThrow(ForgottenSinceLoadError);
    expect(check(retained, held())).not.toThrow();
    expect(check(retained, retainedKey())).not.toThrow();
    expect(check(retained, null)).toThrow(ForgottenSinceLoadError);
  });

  it("refuses a person touched while restricted as a whole, and only then", () => {
    const check = (restrictions: readonly RestrictionRead[]) => () =>
      checkAppend({
        args: append({ touches: ["c-1"] }),
        keyOf: () => null,
        restrictionsOf: (person) => (person === "c-1" ? restrictions : []),
      });
    expect(check([])).not.toThrow();
    expect(check([{ category: "marketing" }])).not.toThrow();
    expect(check([{ category: null }])).toThrow(ProcessingRestrictedError);
  });

  it("refuses a key sealed under whose category, or whose person as a whole, is restricted, and checks it is still held", () => {
    const check = (restrictions: readonly RestrictionRead[], key: KeyRead | null) => () =>
      checkAppend({
        args: append({ seals: [{ person: "c-1", fingerprint: "f-1" }] }),
        keyOf: () => key,
        restrictionsOf: () => restrictions,
      });
    expect(check([{ category: "marketing" }], held("profile"))).not.toThrow();
    expect(check([{ category: "marketing" }], held("marketing"))).toThrow(
      ProcessingRestrictedError,
    );
    expect(check([{ category: null }], held("profile"))).toThrow(ProcessingRestrictedError);
    expect(check([], null)).toThrow(ForgottenSinceLoadError);
    expect(check([{ category: "marketing" }], null)).toThrow(ForgottenSinceLoadError);
  });

  it("refuses a restricted touch before a key that is gone", () => {
    expect(() =>
      checkAppend({
        args: append({ persons: [{ person: "c-1", fingerprint: "f-1" }], touches: ["c-1"] }),
        keyOf: () => null,
        restrictionsOf: () => [{ category: null }],
      }),
    ).toThrow(ProcessingRestrictedError);
  });
});
