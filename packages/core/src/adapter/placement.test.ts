import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../contracts/errors.ts";
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

  it("refuses a storage location it does not know, as a ConfigurationError", () => {
    expect(() =>
      checkPlacement({
        path: "readModels.search",
        holder: { location: "eu" },
        where: "jurisdiction eu" as never,
        fix: () => "never",
      }),
    ).toThrow(
      new ConfigurationError(
        'storage declares where it keeps its data as "jurisdiction eu", which is no location Bounda knows: a country by its ISO 3166-1 alpha-2 code in lower case, such as "de", or one of "eu", "eea", "fedramp", "fedramp-high", "global"',
      ),
    );
  });

  it("accepts a store with neither location nor safeguard under a storage that declares none", () => {
    expect(() =>
      checkPlacement({ path: "readModels.search", holder: {}, where: undefined, fix: () => "" }),
    ).not.toThrow();
  });
});
