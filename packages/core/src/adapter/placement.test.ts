import { describe, expect, it } from "vitest";
import { checkPlacement } from "./placement.ts";

describe("checkPlacement", () => {
  it("refuses a storage in global, which is in no jurisdiction to judge a store against", () => {
    expect(() =>
      checkPlacement({
        path: "readModels.search",
        holder: { location: "global", safeguard: "standard-contractual-clauses" },
        where: "global",
        fix: () => "never",
      }),
    ).toThrow(
      'storage declares the location "global", and storage is where the app keeps its data, which "global" places in no jurisdiction: declare where it keeps it, or no location',
    );
  });

  it("accepts a store with neither location nor safeguard under a storage that declares none", () => {
    expect(() =>
      checkPlacement({ path: "readModels.search", holder: {}, where: undefined, fix: () => "" }),
    ).not.toThrow();
  });
});
