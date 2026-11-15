import { describe, expect, it } from "vitest";
import { fenceOf, stampFence } from "./fences.ts";

describe("fences", () => {
  it("keeps the earliest head a person's read was stamped with, and none for a read never stamped", () => {
    const read = { person: "c-1", fingerprint: "f-1" };
    expect(fenceOf(read)).toBeUndefined();
    stampFence([read], 7);
    stampFence([read], 3);
    stampFence([read], 9);
    expect(fenceOf(read)).toBe(3);
    expect(fenceOf({ ...read })).toBeUndefined();
  });
});
