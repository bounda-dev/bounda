import { describe, expect, it } from "vitest";
import { pendingEvent } from "../testing/fixtures.ts";
import {
  appendPersonsOf,
  checkAppend,
  ForgottenSinceLoadError,
  type KeyState,
} from "./append-checks.ts";
import type { AppendArgs } from "./event-store.ts";
import type { KeyedPerson } from "./personal-key-store.ts";

const append = (names: Pick<AppendArgs, "persons" | "touches">): AppendArgs => ({
  aggregateType: "order",
  aggregateId: "1",
  expectedVersion: 3,
  events: [pendingEvent({ aggregateId: "1", version: 4 })],
  ...names,
});

describe("appendPersonsOf", () => {
  it("names each person once, those with a key apart from those touched", () => {
    expect(appendPersonsOf(append({}))).toEqual({ keyed: [], touched: [] });
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
    ).toEqual({ keyed: ["c-1"], touched: [] });
    expect(appendPersonsOf(append({ touches: ["c-3", "c-3"] }))).toEqual({
      keyed: [],
      touched: ["c-3"],
    });
  });
});

describe("checkAppend", () => {
  it("checks nothing an append does not name", () => {
    expect(() =>
      checkAppend({ args: append({}), keyOf: () => "gone", restricted: () => true }),
    ).not.toThrow();
    expect(() =>
      checkAppend({
        args: append({ persons: [{ person: "c-1", fingerprint: null }] }),
        keyOf: () => "gone",
        restricted: () => true,
      }),
    ).not.toThrow();
  });

  it("names the person and the stream of an append whose key is gone", () => {
    const refused = (() => {
      try {
        checkAppend({
          args: append({ persons: [{ person: "c-1", fingerprint: "f-1" }] }),
          keyOf: () => "gone",
          restricted: () => false,
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

  it("lets a key read in force through while it is in force, and one read retained while it is kept at all", () => {
    const check = (read: KeyedPerson, state: KeyState) => () =>
      checkAppend({
        args: append({ persons: [read] }),
        keyOf: (person, fingerprint) =>
          person === "c-1" && fingerprint === "f-1" ? state : "gone",
        restricted: () => false,
      });
    const inForce = { person: "c-1", fingerprint: "f-1" };
    const retained = { ...inForce, retained: true as const };
    expect(check(inForce, "held")).not.toThrow();
    expect(check(inForce, "retained")).toThrow(ForgottenSinceLoadError);
    expect(check(inForce, "gone")).toThrow(ForgottenSinceLoadError);
    expect(check(retained, "held")).not.toThrow();
    expect(check(retained, "retained")).not.toThrow();
    expect(check(retained, "gone")).toThrow(ForgottenSinceLoadError);
  });
});
