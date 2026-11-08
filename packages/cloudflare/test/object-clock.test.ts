import { createFixedClock } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { objectClock } from "../src/object-clock.ts";

describe("objectClock", () => {
  it("arms the waits that may keep the object awake, and never a background one", () => {
    const base = createFixedClock(new Date("2026-01-01T00:00:00.000Z"));
    const clock = objectClock(base);
    const fired: string[] = [];
    clock.after(1_000, () => fired.push("wait"));
    const cancel = clock.after(500, () => fired.push("background"), { background: true });
    expect(base.pending()).toBe(1);
    cancel();
    base.advance(1_000);
    expect(fired).toEqual(["wait"]);
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:01.000Z"));
  });

  it("cancels a wait it armed", () => {
    const base = createFixedClock();
    const cancel = objectClock(base).after(1_000, () => undefined);
    cancel();
    expect(base.pending()).toBe(0);
  });
});
