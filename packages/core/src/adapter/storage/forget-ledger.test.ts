import { describe, expect, it } from "vitest";
import { forgottenReasonOf } from "./forget-ledger.ts";

describe("forgottenReasonOf", () => {
  it("reads back every reason Bounda knows, and anything else as requested", () => {
    for (const reason of ["requested", "objection", "retention"] as const) {
      expect(forgottenReasonOf(reason)).toBe(reason);
    }
    for (const stored of [undefined, null, "", "whim", 1]) {
      expect(forgottenReasonOf(stored)).toBe("requested");
    }
  });
});
