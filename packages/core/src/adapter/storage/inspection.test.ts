import { describe, expect, it } from "vitest";
import { opaqueColumnsOf } from "./inspection.ts";

describe("opaqueColumnsOf", () => {
  it("takes the columns of a key, superseded or not, for key material alone", () => {
    expect(opaqueColumnsOf("personalKeys", ["person", "key"])).toEqual(["key", "fingerprint"]);
    expect(opaqueColumnsOf("supersededKeys", ["person", "key"])).toEqual([
      "key",
      "fingerprint",
      "successor",
    ]);
    expect(opaqueColumnsOf("events", ["payload"])).toEqual([]);
  });
});
