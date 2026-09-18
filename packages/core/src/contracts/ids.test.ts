import { describe, expect, it } from "vitest";
import { createSequentialIdGenerator, uuidV7IdGenerator } from "./ids.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidV7IdGenerator", () => {
  it("produces valid, unique, time-ordered UUID v7 values", () => {
    const first = uuidV7IdGenerator.next();
    const second = uuidV7IdGenerator.next();
    expect(first).toMatch(UUID_V7);
    expect(second).toMatch(UUID_V7);
    expect(first).not.toBe(second);
    expect(first < second).toBe(true);
  });
});

describe("createSequentialIdGenerator", () => {
  it("counts from one with the given prefix", () => {
    const ids = createSequentialIdGenerator({ prefix: "evt" });
    expect(ids.next()).toBe("evt-1");
    expect(ids.next()).toBe("evt-2");
  });

  it("defaults the prefix to id", () => {
    expect(createSequentialIdGenerator().next()).toBe("id-1");
  });
});
