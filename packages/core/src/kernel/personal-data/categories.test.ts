import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { PersonalDataModule } from "../../modules/personal-data.ts";
import {
  buildPersonalCategories,
  checkCategory,
  checkMarkedCategories,
  formatRetention,
} from "./categories.ts";

// Without decisions given, a module that declares none.
const module = (categories: unknown, ...decisions: unknown[]): PersonalDataModule =>
  ({
    categories,
    automatedDecisions: decisions.length === 0 ? {} : decisions[0],
  }) as PersonalDataModule;

const refusal = (categories: unknown, ...decisions: unknown[]): string => {
  try {
    buildPersonalCategories({ module: module(categories, ...decisions), retention: null });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("buildPersonalCategories", () => {
  it("puts the default category first, with the app's retention and no basis, then the declared ones in order", () => {
    const categories = buildPersonalCategories({
      module: {
        automatedDecisions: {},
        categories: {
          profile: {
            basis: "contract",
            retention: "30d",
            purposes: ["Serve the person"],
            sources: ["data-subject"],
          },
          invoices: {
            basis: "legal-obligation",
            retention: "6y",
            purposes: ["Serve the person"],
            sources: ["data-subject"],
          },
        },
      },
      retention: { months: 0, ms: 5_000 },
    });
    const said = { purposes: ["Serve the person"], sources: ["data-subject"] };
    expect(categories.all).toEqual([
      {
        name: "default",
        basis: null,
        retention: { months: 0, ms: 5_000 },
        purposes: [],
        sources: [],
      },
      { name: "profile", basis: "contract", retention: { months: 0, ms: 2_592_000_000 }, ...said },
      { name: "invoices", basis: "legal-obligation", retention: { months: 72, ms: 0 }, ...said },
    ]);
    expect(categories.decisions).toEqual([]);
    expect(categories.declared.map(({ name }) => name)).toEqual(["profile", "invoices"]);
    expect(categories.of("invoices")?.basis).toBe("legal-obligation");
    expect(categories.of("default")?.retention).toEqual({ months: 0, ms: 5_000 });
    expect(categories.of("nope")).toBeUndefined();
  });

  it("has the default category alone without app/personal-data.ts", () => {
    const categories = buildPersonalCategories({ module: undefined, retention: null });
    expect(categories.all).toEqual([
      { name: "default", basis: null, retention: null, purposes: [], sources: [] },
    ]);
    expect(categories.declared).toEqual([]);
    expect(categories.decisions).toEqual([]);
  });

  it("keeps the purposes, the sources and the automated decisions it declares, and refuses those it cannot read", () => {
    const profile = {
      basis: "contract",
      retention: "1d",
      purposes: ["Greet them", "Bill them"],
      sources: [
        "data-subject",
        "derived",
        { kind: "third-party", name: "A broker" },
        { kind: "public", name: "The register" },
      ],
    };
    const scoring = {
      categories: ["profile", "default"],
      logic: "A score of their answers",
      significance: "Whether they may pay later",
      consequences: "Paying upfront",
      profiling: true,
      ground: "explicit-consent",
    };
    const built = buildPersonalCategories({
      module: module({ profile }, { scoring }),
      retention: null,
    });
    expect(built.of("profile")).toMatchObject({
      purposes: profile.purposes,
      sources: profile.sources,
    });
    expect(built.decisions).toEqual([{ name: "scoring", ...scoring }]);
    const at = 'app/personal-data.ts: category "profile"';
    const purposes = `${at} must name its purposes, at least one, each in words for the person`;
    for (const wrong of [undefined, [], [" "], [1], ["Greet them", " "], "Greet them"]) {
      expect(refusal({ profile: { ...profile, purposes: wrong } })).toBe(purposes);
    }
    const sources = `${at} must name its sources, at least one: "data-subject", "derived", or { kind: "third-party" or "public", name }`;
    for (const wrong of [
      undefined,
      [],
      ["rumour"],
      [null],
      [{ kind: "third-party" }],
      [{ kind: "public", name: " " }],
      [{ kind: "broker", name: "A broker" }],
      "data-subject",
    ]) {
      expect(refusal({ profile: { ...profile, sources: wrong } })).toBe(sources);
    }
    for (const wrong of [undefined, null, [], "none"]) {
      expect(refusal({ profile }, wrong)).toBe(
        "app/personal-data.ts must export automatedDecisions as an object, {} when the app decides nothing about a person by automated means alone",
      );
    }
    const decision = 'app/personal-data.ts: automated decision "scoring"';
    for (const wrong of [undefined, [], ["credit"], [1], "profile"]) {
      expect(refusal({ profile }, { scoring: { ...scoring, categories: wrong } })).toBe(
        `${decision} must name the categories it decides on, at least one, each declared or "default"`,
      );
    }
    expect(refusal({ profile }, { scoring: null })).toContain("must name the categories");
    for (const field of ["logic", "significance", "consequences"]) {
      for (const wrong of [undefined, "", "  ", 3]) {
        expect(refusal({ profile }, { scoring: { ...scoring, [field]: wrong } })).toBe(
          `${decision} must give its ${field} in words for the person`,
        );
      }
    }
    for (const wrong of [undefined, "yes", 1]) {
      expect(refusal({ profile }, { scoring: { ...scoring, profiling: wrong } })).toBe(
        `${decision} must say whether it profiles the person`,
      );
    }
    expect(
      buildPersonalCategories({
        module: module({ profile }, { scoring: { ...scoring, profiling: false } }),
        retention: null,
      }).decisions[0]?.profiling,
    ).toBe(false);
    for (const wrong of [undefined, "whim", "consent"]) {
      expect(refusal({ profile }, { scoring: { ...scoring, ground: wrong } })).toBe(
        `${decision} must name its ground, one of "contract", "law", "explicit-consent"`,
      );
    }
  });

  it("refuses what the types would have refused, naming the category and the rule", () => {
    expect(refusal(null)).toBe("app/personal-data.ts must export categories as an object");
    expect(refusal(["profile"])).toBe("app/personal-data.ts must export categories as an object");
    expect(refusal("profile")).toBe("app/personal-data.ts must export categories as an object");
    expect(
      refusal({
        default: {
          basis: "consent",
          retention: "1d",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      }),
    ).toBe(
      'app/personal-data.ts: category "default" is the category of fields marked without one, and cannot be declared',
    );
    for (const name of ["1st", "with space", "-dash", ""]) {
      expect(
        refusal({
          [name]: {
            basis: "consent",
            retention: "1d",
            purposes: ["Serve the person"],
            sources: ["data-subject"],
          },
        }),
      ).toBe(
        `app/personal-data.ts: category "${name}" must start with a letter and hold only letters, digits, "-" and "_"`,
      );
    }
    expect(
      refusal({
        a_b: {
          basis: "whim",
          retention: "1d",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      }),
    ).toBe(
      'app/personal-data.ts: category "a_b" must name its basis, one of "consent", "contract", "legal-obligation", "vital-interests", "public-task", "legitimate-interests"',
    );
    expect(refusal({ "a-1": null })).toContain("must name its basis");
    expect(
      refusal({
        profile: {
          basis: "consent",
          retention: "a month",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      }),
    ).toBe(
      'app/personal-data.ts: category "profile" must give its retention as a duration, such as "30d", milliseconds, or whole months or years, such as "6y"',
    );
    expect(
      refusal({
        profile: {
          basis: "consent",
          retention: 0,
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      }),
    ).toBe('app/personal-data.ts: category "profile" must keep its data for more than no time');
    expect(
      buildPersonalCategories({
        module: module({
          p: {
            basis: "consent",
            retention: 1,
            purposes: ["Serve the person"],
            sources: ["data-subject"],
          },
        }),
        retention: null,
      }).of("p")?.retention,
    ).toEqual({ months: 0, ms: 1 });
  });
});

describe("checkMarkedCategories", () => {
  const categories = buildPersonalCategories({
    module: {
      automatedDecisions: {},
      categories: {
        profile: {
          basis: "consent",
          retention: "1d",
          purposes: ["Serve the person"],
          sources: ["data-subject"],
        },
      },
    },
    retention: null,
  });
  const marked = (fields: Record<string, string>) => ({ personal: { categories: fields } });
  const check = (
    places: Partial<Omit<Parameters<typeof checkMarkedCategories>[0], "categories">>,
  ): void =>
    checkMarkedCategories({
      categories,
      aggregates: { byName: {} },
      processes: { all: [] },
      readModels: {},
      ...places,
    });

  it("lets through marks in a category the app has, and fields without a mark", () => {
    expect(() =>
      check({
        aggregates: {
          byName: {
            customer: {
              eventsByType: { CustomerRegistered: marked({ email: "profile", note: "default" }) },
              commands: { RegisterCustomer: { personal: null } },
            },
          },
        },
        processes: { all: [{ name: "onboarding", ...marked({ email: "profile" }) }] },
        readModels: {
          directory: { fields: { email: { category: "profile" }, id: { category: null } } },
        },
      }),
    ).not.toThrow();
  });

  it("names where a mark is in a category the app does not declare", () => {
    const refused = (places: Parameters<typeof check>[0]): string => {
      try {
        check(places);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        return (error as Error).message;
      }
      throw new Error("expected a refusal");
    };
    const unknown =
      'is marked personal in the category "billing", which app/personal-data.ts does not declare';
    expect(
      refused({
        aggregates: {
          byName: {
            order: { eventsByType: { OrderPlaced: marked({ address: "billing" }) }, commands: {} },
          },
        },
      }),
    ).toBe(`Event order.OrderPlaced, field "address" ${unknown}`);
    expect(
      refused({
        aggregates: {
          byName: {
            order: { eventsByType: {}, commands: { PlaceOrder: marked({ address: "billing" }) } },
          },
        },
      }),
    ).toBe(`Command order.PlaceOrder, field "address" ${unknown}`);
    expect(
      refused({ processes: { all: [{ name: "payment", ...marked({ address: "billing" }) }] } }),
    ).toBe(`State of process payment, field "address" ${unknown}`);
    expect(
      refused({ readModels: { orders: { fields: { address: { category: "billing" } } } } }),
    ).toBe(`Read model orders, field "address" ${unknown}`);
  });

  it("checks one category at a time", () => {
    expect(() => checkCategory({ categories, category: "profile", at: "x" })).not.toThrow();
    expect(() => checkCategory({ categories, category: "default", at: "x" })).not.toThrow();
    expect(() => checkCategory({ categories, category: "nope", at: "x" })).toThrow(
      ConfigurationError,
    );
  });
});

describe("formatRetention", () => {
  it("writes a retention in the largest unit that divides it", () => {
    const ms = (value: number) => formatRetention({ months: 0, ms: value });
    expect(ms(2 * 86_400_000)).toBe("2d");
    expect(ms(3 * 3_600_000)).toBe("3h");
    expect(ms(90 * 60_000)).toBe("90m");
    expect(ms(5_000)).toBe("5s");
    expect(ms(1_500)).toBe("1500ms");
    expect(ms(0)).toBe("0d");
    expect(formatRetention({ months: 72, ms: 0 })).toBe("6y");
    expect(formatRetention({ months: 18, ms: 0 })).toBe("18mo");
    expect(formatRetention({ months: 1, ms: 0 })).toBe("1mo");
  });
});
