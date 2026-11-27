import { PARTIAL_ADEQUACY } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { formatTransfer } from "./transfer-output.ts";

describe("formatTransfer", () => {
  it.each([
    ["US", "transferred to US under binding-corporate-rules (article 47)"],
    ["EEA", "transferred to the EEA under binding-corporate-rules (article 47)"],
    ["anywhere", "transferred anywhere under binding-corporate-rules (article 47)"],
  ] as const)("names the regime %s the data goes to", (regime, text) => {
    expect(
      formatTransfer(
        { safeguard: "binding-corporate-rules", article: "47", regime, partialAdequacy: null },
        "recipient",
      ),
    ).toBe(text);
  });

  it.each([
    ["recipient", "the recipient"],
    ["provider", "the provider keeping it"],
  ] as const)("names the partial decision and what to verify of the %s", (holder, named) => {
    expect(
      formatTransfer(
        {
          safeguard: "adequacy",
          article: "45",
          regime: "US",
          partialAdequacy: PARTIAL_ADEQUACY.US,
        },
        holder,
      ),
    ).toBe(
      `transferred to US under adequacy (article 45), on Commission Implementing Decision (EU) 2023/1795, for organisations in the United States included in the Data Privacy Framework List of the US Department of Commerce alone: verify ${named} is on the Data Privacy Framework List, with an active certification that covers the data transferred, human resources data or other`,
    );
  });
});
