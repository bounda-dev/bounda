import { describe, expect, it } from "vitest";
import { earliestDue } from "./scheduling.ts";

const iso = (ms: number): string => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const at = (ms: number): Date => new Date(Date.UTC(2026, 0, 1) + ms);

describe("earliestDue", () => {
  it("is null when the table has nothing, whatever the engine returns for empty aggregates", () => {
    expect(earliestDue({ unclaimed: null, claimed: null, leaseMs: 1_000 })).toBeNull();
    expect(earliestDue({ unclaimed: undefined, claimed: undefined, leaseMs: 1_000 })).toBeNull();
  });

  it("takes the soonest unclaimed command when nothing is held", () => {
    expect(earliestDue({ unclaimed: iso(5_000), claimed: null, leaseMs: 1_000 })).toEqual(
      at(5_000),
    );
  });

  it("takes the end of the oldest lease, one millisecond after it, when only that is left", () => {
    expect(earliestDue({ unclaimed: null, claimed: iso(5_000), leaseMs: 1_000 })).toEqual(
      at(6_001),
    );
  });

  it("takes whichever comes first", () => {
    expect(earliestDue({ unclaimed: iso(60_000), claimed: iso(5_000), leaseMs: 1_000 })).toEqual(
      at(6_001),
    );
    expect(earliestDue({ unclaimed: iso(2_000), claimed: iso(5_000), leaseMs: 1_000 })).toEqual(
      at(2_000),
    );
  });
});
