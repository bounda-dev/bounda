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
    const said = {
      purposes: ["Serve the person"],
      sources: ["data-subject"],
      special: null,
      criminal: null,
      processedFor: [],
    };
    expect(categories.all).toEqual([
      {
        name: "default",
        basis: null,
        retention: { months: 0, ms: 5_000 },
        purposes: [],
        sources: [],
        special: null,
        criminal: null,
        processedFor: [],
        exemptions: [],
      },
      {
        name: "profile",
        basis: "contract",
        retention: { months: 0, ms: 2_592_000_000 },
        ...said,
        exemptions: [],
      },
      {
        name: "invoices",
        basis: "legal-obligation",
        retention: { months: 72, ms: 0 },
        ...said,
        exemptions: ["legal-obligation"],
      },
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
      {
        name: "default",
        basis: null,
        retention: null,
        purposes: [],
        sources: [],
        special: null,
        criminal: null,
        processedFor: [],
        exemptions: [],
      },
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

  it("keeps the special categories of data and the criminal data a category declares, with their condition and authority, and refuses those it cannot read", () => {
    const said = { retention: "1d", purposes: ["Treat them"], sources: ["data-subject"] };
    const built = buildPersonalCategories({
      module: module({
        care: {
          basis: "contract",
          ...said,
          special: { kinds: ["health", "genetic"], condition: "health-or-social-care" },
        },
        record: { basis: "legal-obligation", ...said, criminal: { authority: "law" } },
        both: {
          basis: "public-task",
          ...said,
          special: { kinds: ["sex-life-or-sexual-orientation"], condition: "legal-claims" },
          criminal: { authority: "official-authority" },
        },
        kept: {
          basis: "legal-obligation",
          ...said,
          special: {
            kinds: ["trade-union-membership"],
            condition: "employment-and-social-protection",
          },
        },
      }),
      retention: null,
    });
    expect(built.of("care")).toMatchObject({
      special: { kinds: ["health", "genetic"], condition: "health-or-social-care" },
      criminal: null,
    });
    expect(built.of("record")).toMatchObject({ special: null, criminal: { authority: "law" } });
    expect(built.of("both")).toMatchObject({
      special: { kinds: ["sex-life-or-sexual-orientation"], condition: "legal-claims" },
      criminal: { authority: "official-authority" },
    });
    expect(built.of("kept")?.special?.condition).toBe("employment-and-social-protection");
    const at = 'app/personal-data.ts: category "care"';
    const kinds = `${at} must name the special categories of data it holds, at least one of "racial-or-ethnic-origin", "political-opinions", "religious-or-philosophical-beliefs", "trade-union-membership", "genetic", "biometric", "health", "sex-life-or-sexual-orientation"`;
    for (const wrong of [
      null,
      "health",
      [],
      { condition: "explicit-consent" },
      { kinds: [], condition: "explicit-consent" },
      { kinds: ["gossip"], condition: "explicit-consent" },
      { kinds: ["health", 1], condition: "explicit-consent" },
      { kinds: "health", condition: "explicit-consent" },
    ]) {
      expect(refusal({ care: { basis: "contract", ...said, special: wrong } })).toBe(kinds);
    }
    for (const wrong of [undefined, "whim", "consent", null]) {
      expect(
        refusal({
          care: { basis: "contract", ...said, special: { kinds: ["health"], condition: wrong } },
        }),
      ).toBe(
        `${at} must name the condition of article 9(2) it processes special categories of data on, one of "explicit-consent", "employment-and-social-protection", "vital-interests", "not-for-profit-body", "made-public", "legal-claims", "substantial-public-interest", "health-or-social-care", "public-health", "archiving-research-or-statistics"`,
      );
    }
    for (const wrong of [null, "law", {}, { authority: "court" }, { authority: undefined }]) {
      expect(refusal({ care: { basis: "contract", ...said, criminal: wrong } })).toBe(
        `${at} must name the authority of article 10 it processes criminal data under, one of "official-authority", "law"`,
      );
    }
    expect(
      refusal({
        care: {
          basis: "legal-obligation",
          ...said,
          special: { kinds: ["health"], condition: "explicit-consent" },
        },
      }),
    ).toBe(
      `${at} is kept past a forgetting (legal-obligation), and cannot rest its special categories of data on explicit-consent, which a withdrawal ends`,
    );
    expect(
      buildPersonalCategories({
        module: module({
          care: {
            basis: "consent",
            ...said,
            special: { kinds: ["health"], condition: "explicit-consent" },
          },
        }),
        retention: null,
      }).of("care")?.special,
    ).toEqual({ kinds: ["health"], condition: "explicit-consent" });
  });

  it("keeps the purposes the GDPR has rules for, and refuses those it cannot read and special data on archiving-research-or-statistics without one of article 89(1)", () => {
    const said = { retention: "1d", purposes: ["Write to them"], sources: ["data-subject"] };
    const built = buildPersonalCategories({
      module: module({
        news: { basis: "consent", ...said, processedFor: ["direct-marketing"] },
        study: {
          basis: "legitimate-interests",
          ...said,
          processedFor: ["statistics", "scientific-or-historical-research"],
          special: { kinds: ["health"], condition: "archiving-research-or-statistics" },
        },
        archive: {
          basis: "public-task",
          ...said,
          processedFor: ["archiving-in-the-public-interest"],
          special: { kinds: ["political-opinions"], condition: "archiving-research-or-statistics" },
        },
        plain: { basis: "contract", ...said },
      }),
      retention: null,
    });
    expect(built.of("news")?.processedFor).toEqual(["direct-marketing"]);
    expect(built.of("study")?.processedFor).toEqual([
      "statistics",
      "scientific-or-historical-research",
    ]);
    expect(built.of("archive")?.processedFor).toEqual(["archiving-in-the-public-interest"]);
    expect(built.of("plain")?.processedFor).toEqual([]);
    const at = 'app/personal-data.ts: category "news"';
    for (const wrong of [null, [], ["whim"], "direct-marketing", ["direct-marketing", 1]]) {
      expect(refusal({ news: { basis: "consent", ...said, processedFor: wrong } })).toBe(
        `${at} must name in processedFor at least one of "direct-marketing", "archiving-in-the-public-interest", "scientific-or-historical-research", "statistics"`,
      );
    }
    const archival = `${at} holds special categories of data on archiving-research-or-statistics and must name the purpose of article 89(1) it serves in processedFor, one of "archiving-in-the-public-interest", "scientific-or-historical-research", "statistics"`;
    const special = { kinds: ["health"], condition: "archiving-research-or-statistics" };
    expect(refusal({ news: { basis: "contract", ...said, special } })).toBe(archival);
    expect(
      refusal({
        news: { basis: "contract", ...said, special, processedFor: ["direct-marketing"] },
      }),
    ).toBe(archival);
  });

  it("names the exemptions of article 17(3) a category's basis, condition and claim carry, none on consent, and refuses a claim that does not apply", () => {
    const said = { retention: "1d", purposes: ["Treat them"], sources: ["data-subject"] };
    const on = (condition: string) => ({ kinds: ["health"], condition });
    const built = buildPersonalCategories({
      module: module({
        served: { basis: "contract", ...said },
        taxed: { basis: "legal-obligation", ...said },
        public: { basis: "public-task", ...said },
        treated: { basis: "contract", ...said, special: on("health-or-social-care") },
        screened: {
          basis: "contract",
          ...said,
          special: on("health-or-social-care"),
          erasureExemption: "public-health",
        },
        tracked: { basis: "vital-interests", ...said, special: on("public-health") },
        claimed: {
          basis: "vital-interests",
          ...said,
          special: on("public-health"),
          erasureExemption: "public-health",
        },
        disputed: { basis: "contract", ...said, special: on("legal-claims") },
        consented: { basis: "consent", ...said, special: on("public-health") },
        defended: { basis: "consent", ...said, special: on("legal-claims") },
        counted: {
          basis: "legitimate-interests",
          ...said,
          processedFor: ["statistics"],
          erasureExemption: "archiving-research-or-statistics",
        },
        uncounted: { basis: "legitimate-interests", ...said, processedFor: ["statistics"] },
        everything: {
          basis: "legal-obligation",
          ...said,
          special: on("public-health"),
          processedFor: ["archiving-in-the-public-interest"],
          erasureExemption: "archiving-research-or-statistics",
        },
        litigated: { basis: "public-task", ...said, special: on("legal-claims") },
      }),
      retention: null,
    });
    const exemptions = Object.fromEntries(
      built.declared.map(({ name, exemptions: held }) => [name, held]),
    );
    expect(exemptions).toEqual({
      served: [],
      taxed: ["legal-obligation"],
      public: ["public-task"],
      treated: [],
      screened: ["public-health"],
      tracked: ["public-health"],
      claimed: ["public-health"],
      disputed: ["legal-claims"],
      consented: [],
      defended: [],
      counted: ["archiving-research-or-statistics"],
      uncounted: [],
      everything: ["legal-obligation", "public-health", "archiving-research-or-statistics"],
      litigated: ["public-task", "legal-claims"],
    });
    const at = 'app/personal-data.ts: category "care"';
    for (const wrong of [null, "whim", "legal-obligation", "public-task", "legal-claims"]) {
      expect(refusal({ care: { basis: "contract", ...said, erasureExemption: wrong } })).toBe(
        `${at} must name as its erasureExemption one of "public-health", "archiving-research-or-statistics"`,
      );
    }
    for (const claim of ["public-health", "archiving-research-or-statistics"]) {
      expect(
        refusal({
          care: {
            basis: "consent",
            ...said,
            special: on("public-health"),
            processedFor: ["statistics"],
            erasureExemption: claim,
          },
        }),
      ).toBe(
        `${at} is on consent, which a withdrawal leaves without a basis to keep it on, and cannot claim an erasureExemption`,
      );
    }
    const health = `${at} claims public-health (article 17(3)(c)), which needs special categories of data on health-or-social-care or public-health`;
    expect(
      refusal({ care: { basis: "contract", ...said, erasureExemption: "public-health" } }),
    ).toBe(health);
    expect(
      refusal({
        care: {
          basis: "contract",
          ...said,
          special: on("vital-interests"),
          erasureExemption: "public-health",
        },
      }),
    ).toBe(health);
    const research = `${at} claims archiving-research-or-statistics (article 17(3)(d)), which needs one of "archiving-in-the-public-interest", "scientific-or-historical-research", "statistics" in processedFor`;
    for (const processedFor of [undefined, ["direct-marketing"]]) {
      expect(
        refusal({
          care: {
            basis: "contract",
            ...said,
            ...(processedFor === undefined ? {} : { processedFor }),
            erasureExemption: "archiving-research-or-statistics",
          },
        }),
      ).toBe(research);
    }
  });

  it("refuses a category kept past a forgetting whose special data rests on explicit consent, or that is processed for direct marketing", () => {
    const said = { retention: "1d", purposes: ["Write to them"], sources: ["data-subject"] };
    const at = 'app/personal-data.ts: category "news"';
    const consented = { kinds: ["health"], condition: "explicit-consent" };
    expect(refusal({ news: { basis: "public-task", ...said, special: consented } })).toBe(
      `${at} is kept past a forgetting (public-task), and cannot rest its special categories of data on explicit-consent, which a withdrawal ends`,
    );
    expect(
      refusal({
        news: {
          basis: "contract",
          ...said,
          special: consented,
          processedFor: ["scientific-or-historical-research"],
          erasureExemption: "archiving-research-or-statistics",
        },
      }),
    ).toBe(
      `${at} is kept past a forgetting (archiving-research-or-statistics), and cannot rest its special categories of data on explicit-consent, which a withdrawal ends`,
    );
    const marketing = (exemptions: string) =>
      `${at} is kept past a forgetting (${exemptions}), and cannot be processed for direct-marketing, which an objection stops at once (article 21(3))`;
    expect(
      refusal({ news: { basis: "legal-obligation", ...said, processedFor: ["direct-marketing"] } }),
    ).toBe(marketing("legal-obligation"));
    expect(
      refusal({
        news: {
          basis: "contract",
          ...said,
          special: { kinds: ["health"], condition: "legal-claims" },
          processedFor: ["statistics", "direct-marketing"],
          erasureExemption: "archiving-research-or-statistics",
        },
      }),
    ).toBe(marketing("archiving-research-or-statistics, legal-claims"));
    const allowed = buildPersonalCategories({
      module: module({
        news: { basis: "legitimate-interests", ...said, processedFor: ["direct-marketing"] },
        offers: {
          basis: "consent",
          ...said,
          special: { kinds: ["health"], condition: "public-health" },
          processedFor: ["direct-marketing"],
        },
        consented: { basis: "contract", ...said, special: consented },
      }),
      retention: null,
    });
    expect(allowed.declared.map(({ name }) => name)).toEqual(["news", "offers", "consented"]);
  });

  it("lets an automated decision on special categories of data rest only on explicit consent or a substantial public interest, with its measures, as article 22(4) asks", () => {
    const said = { retention: "1d", purposes: ["Treat them"], sources: ["data-subject"] };
    const categories = {
      profile: { basis: "contract", ...said },
      consented: {
        basis: "contract",
        ...said,
        special: { kinds: ["health"], condition: "explicit-consent" },
      },
      public: {
        basis: "public-task",
        ...said,
        special: { kinds: ["biometric"], condition: "substantial-public-interest" },
      },
      care: {
        basis: "contract",
        ...said,
        special: { kinds: ["health"], condition: "health-or-social-care" },
      },
      record: { basis: "legal-obligation", ...said, criminal: { authority: "law" } },
    };
    const decision = {
      logic: "A score of their answers",
      significance: "Whether they are covered",
      consequences: "A human decides instead",
      profiling: true,
      ground: "explicit-consent",
    };
    const measures = "A clinician reviews every refusal";
    const built = buildPersonalCategories({
      module: module(categories, {
        cover: { ...decision, categories: ["consented", "public", "profile"], measures },
        vet: { ...decision, categories: ["record", "profile"] },
        greet: { ...decision, categories: ["profile"], measures },
      }),
      retention: null,
    });
    expect(built.decisions).toEqual([
      { name: "cover", ...decision, categories: ["consented", "public", "profile"], measures },
      { name: "vet", ...decision, categories: ["record", "profile"] },
      { name: "greet", ...decision, categories: ["profile"], measures },
    ]);
    expect(built.decisions[1]).not.toHaveProperty("measures");
    const at = 'app/personal-data.ts: automated decision "cover"';
    expect(
      refusal(categories, { cover: { ...decision, categories: ["consented", "care"], measures } }),
    ).toBe(
      `${at} decides on special categories of data of "care", processed on "health-or-social-care"; article 22(4) allows it only on "explicit-consent", "substantial-public-interest"`,
    );
    for (const decided of [["consented"], ["profile", "public"]]) {
      expect(refusal(categories, { cover: { ...decision, categories: decided } })).toBe(
        `${at} decides on special categories of data and must give the measures that safeguard the person, in words for them (article 22(4))`,
      );
    }
    for (const wrong of ["", "  ", 3, null]) {
      expect(
        refusal(categories, { cover: { ...decision, categories: ["profile"], measures: wrong } }),
      ).toBe(`${at} must give its measures in words for the person`);
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
