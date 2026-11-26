import { describe, expect, it } from "vitest";
import { formatTransfer } from "./transfer-output.ts";

describe("formatTransfer", () => {
  it.each([
    ["US", "transferred to US under binding-corporate-rules (article 47)"],
    ["EEA", "transferred to the EEA under binding-corporate-rules (article 47)"],
    ["anywhere", "transferred anywhere under binding-corporate-rules (article 47)"],
  ] as const)("names the regime %s the data goes to", (regime, text) => {
    expect(formatTransfer({ safeguard: "binding-corporate-rules", article: "47", regime })).toBe(
      text,
    );
  });
});
