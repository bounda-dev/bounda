import { describe, expect, it } from "vitest";
import { createCallCounter } from "./counted-calls.ts";

describe("createCallCounter", () => {
  it("counts the calls of every function reached through each target, as deep as told, and hands back what they return", async () => {
    const key = new Uint8Array([1, 2]);
    const store = {
      name: "events",
      read: async (id: string) => `read ${id}`,
      nested: { open: () => key, deeper: { far: () => "far" } },
    };
    const counter = createCallCounter();
    const counted = counter.count(store, 2);
    const other = counter.count({ list: () => [1] }, 1);
    expect(counter.calls()).toBe(0);
    expect(counted.name).toBe("events");
    expect(await counted.read("e-1")).toBe("read e-1");
    expect(counted.nested.open()).toBe(key);
    expect(other.list()).toEqual([1]);
    expect(counter.calls()).toBe(3);
    // Past its depth, a target is reached as it is.
    expect(counted.nested.deeper.far()).toBe("far");
    expect(counter.calls()).toBe(3);
    expect(counter.count(store, 0)).toBe(store);
  });
});
