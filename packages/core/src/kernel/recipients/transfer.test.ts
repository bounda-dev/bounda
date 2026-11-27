import { describe, expect, it } from "vitest";
import { PARTIAL_ADEQUACY } from "../../modules/recipient.ts";
import { recipientTransferOf } from "./transfer.ts";

describe("recipientTransferOf", () => {
  it("names the partial decision a transfer on adequacy to Canada or the United States rests on", () => {
    expect(recipientTransferOf("US", "adequacy")).toEqual({
      safeguard: "adequacy",
      article: "45",
      regime: "US",
      partialAdequacy: PARTIAL_ADEQUACY.US,
    });
    expect(recipientTransferOf("CA", "adequacy")?.partialAdequacy).toBe(PARTIAL_ADEQUACY.CA);
  });

  it("names none for another safeguard there, or adequacy anywhere else", () => {
    expect(recipientTransferOf("US", "standard-contractual-clauses")).toEqual({
      safeguard: "standard-contractual-clauses",
      article: "46(2)(c)",
      regime: "US",
      partialAdequacy: null,
    });
    expect(recipientTransferOf("CH", "adequacy")?.partialAdequacy).toBeNull();
    expect(recipientTransferOf("FR", null)).toBeNull();
  });
});
