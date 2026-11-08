import { describe, expect, it } from "vitest";
import { quoteName } from "./inspection.ts";

describe("quoteName", () => {
  it("double-quotes a name, doubling the quotes in it", () => {
    expect(quoteName("bounda_events")).toBe('"bounda_events"');
    expect(quoteName('odd"name')).toBe('"odd""name"');
  });
});
