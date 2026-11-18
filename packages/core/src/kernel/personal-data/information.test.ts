import { describe, expect, it } from "vitest";
import type { StoredPerson } from "../../adapter/storage/person-store.ts";
import type { HeldPersonalKey } from "../../adapter/storage/personal-key-store.ts";
import { testPersonalKey } from "../../adapter/testing/fixtures.ts";
import type { PersonalDataModule } from "../../modules/personal-data.ts";
import { buildPersonalCategories } from "./categories.ts";
import { personalDataInformation } from "./information.ts";

const said = { purposes: ["Serve the person"], sources: ["data-subject"] } as const;

const scoring = {
  categories: ["profile"],
  logic: "A score of their answers",
  significance: "Whether they may pay later",
  consequences: "Paying upfront",
  profiling: true,
  ground: "contract",
} as const;

const module = {
  categories: {
    profile: { basis: "contract", retention: "30d", ...said },
    invoices: { basis: "legal-obligation", retention: "60d", ...said },
    newsletter: { basis: "consent", retention: "10d", ...said },
    fraud: { basis: "legitimate-interests", retention: "90d", ...said },
    census: { basis: "public-task", retention: "1y", ...said },
  },
  automatedDecisions: {
    scoring,
    vetting: { ...scoring, categories: ["fraud", "census"], ground: "law" },
    targeting: { ...scoring, categories: ["newsletter"], ground: "explicit-consent" },
  },
} as unknown as PersonalDataModule;

const categories = buildPersonalCategories({
  module,
  retention: { months: 0, ms: 20 * 86_400_000 },
});

const key = (
  category: string,
  lastActiveAt: string | null,
  retainedSince: string | null = null,
): HeldPersonalKey => ({
  category,
  key: testPersonalKey(category),
  retainedSince,
  lastActiveAt,
});

const person = (
  lastActiveAt: string | null,
  restrictedSince: string | null = null,
): StoredPerson => ({
  person: "ana",
  restrictedSince,
  lastActiveAt,
  position: 1,
  forgottenAt: null,
  hold: null,
});

describe("personalDataInformation", () => {
  it("tells each category's basis, purposes, sources and retention, and whether the person holds data of it", () => {
    const { categories: told } = personalDataInformation({
      categories,
      keys: [key("profile", null)],
      person: null,
    });
    expect(told.default).toEqual({
      basis: null,
      special: null,
      criminal: null,
      purposes: [],
      processedFor: [],
      erasureExemptions: [],
      sources: [],
      retention: "20d",
      held: false,
      keptUntil: null,
      restrictedUntil: null,
    });
    expect(told.profile).toEqual({
      basis: "contract",
      special: null,
      criminal: null,
      ...said,
      processedFor: [],
      erasureExemptions: [],
      retention: "30d",
      held: true,
      keptUntil: null,
      restrictedUntil: null,
    });
    expect(told.newsletter?.held).toBe(false);
  });

  it("tells until when each category is kept unless they are active again, the whole person going first", () => {
    const { categories: told } = personalDataInformation({
      categories,
      keys: [
        key("default", "2026-01-01T00:00:00.000Z"),
        key("profile", "2026-01-01T00:00:00.000Z"),
        key("newsletter", "2026-01-01T00:00:00.000Z"),
        key("invoices", "2026-01-01T00:00:00.000Z"),
        key("census", "2026-01-01T00:00:00.000Z"),
        key("fraud", null),
      ],
      person: person("2026-01-01T00:00:00.000Z"),
    });
    // The person as a whole, after the default category's retention.
    expect(told.default?.keptUntil).toBe("2026-01-21T00:00:00.000Z");
    expect(told.profile?.keptUntil).toBe("2026-01-21T00:00:00.000Z");
    // Sooner on its own.
    expect(told.newsletter?.keptUntil).toBe("2026-01-11T00:00:00.000Z");
    // Kept past the whole forgetting, by law or for a task in the public interest.
    expect(told.invoices?.keptUntil).toBe("2026-03-02T00:00:00.000Z");
    expect(told.census?.keptUntil).toBe("2027-01-01T00:00:00.000Z");
    // Without activity of its own, as the whole goes.
    expect(told.fraud?.keptUntil).toBe("2026-01-21T00:00:00.000Z");
  });

  it("tells no end while nothing forgets them: without activity, retention or keys in force", () => {
    const keys = [key("profile", "2026-01-01T00:00:00.000Z")];
    const told = (args: Partial<Parameters<typeof personalDataInformation>[0]>) =>
      personalDataInformation({ categories, keys, person: null, ...args }).categories;
    expect(told({}).profile?.keptUntil).toBe("2026-01-31T00:00:00.000Z");
    // Restricted, the same end, which the retention waits on until the restriction is lifted.
    expect(
      told({ person: person("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z") }).profile
        ?.keptUntil,
    ).toBe("2026-01-21T00:00:00.000Z");
    expect(told({ keys: [key("profile", null)] }).profile?.keptUntil).toBeNull();
    expect(
      told({ keys: [key("profile", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z")] })
        .profile,
    ).toMatchObject({ held: true, keptUntil: null, restrictedUntil: "2026-01-31T00:00:00.000Z" });
    // Nothing of it in force, so nothing for the whole person's retention to forget either.
    expect(
      told({
        keys: [key("profile", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z")],
        person: person("2026-01-01T00:00:00.000Z"),
      }).profile?.keptUntil,
    ).toBeNull();
    const noRetention = buildPersonalCategories({ module: undefined, retention: null });
    expect(
      personalDataInformation({
        categories: noRetention,
        keys: [key("default", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z")],
        person: person("2026-01-01T00:00:00.000Z"),
      }).categories.default,
    ).toMatchObject({ held: true, keptUntil: null, restrictedUntil: null });
  });

  it("tells until when what forgettings kept stays, the latest of them", () => {
    const { categories: told } = personalDataInformation({
      categories,
      keys: [
        key("invoices", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"),
        key("invoices", "2026-02-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"),
        key("invoices", "2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00.000Z"),
      ],
      person: null,
    });
    expect(told.invoices).toMatchObject({
      held: true,
      restrictedUntil: "2026-04-02T00:00:00.000Z",
    });
  });

  it("tells each right with the categories it reaches, by their basis, and the decisions on what they hold", () => {
    const { rights, automatedDecisions } = personalDataInformation({
      categories,
      keys: [key("profile", null), key("fraud", null)],
      person: null,
    });
    expect(rights).toEqual([
      { right: "access", article: "15", categories: null },
      { right: "rectification", article: "16", categories: null },
      {
        right: "erasure",
        article: "17",
        categories: ["default", "profile", "newsletter", "fraud"],
      },
      { right: "restriction", article: "18", categories: null },
      { right: "portability", article: "20", categories: ["profile", "newsletter"] },
      { right: "objection", article: "21(1)", categories: ["fraud", "census"] },
      { right: "withdraw-consent", article: "7(3)", categories: ["newsletter"] },
      { right: "human-intervention", article: "22(3)", categories: ["profile"] },
      { right: "complaint", article: "77", categories: null },
    ]);
    expect(automatedDecisions).toEqual([
      { name: "scoring", ...scoring },
      { name: "vetting", ...scoring, categories: ["fraud", "census"], ground: "law" },
    ]);
  });

  it("tells the special categories of data and the criminal data of each category, and lets explicit consent be withdrawn and its data be carried, whatever the basis", () => {
    const special = buildPersonalCategories({
      module: {
        categories: {
          care: {
            basis: "vital-interests",
            retention: "1y",
            ...said,
            special: { kinds: ["health"], condition: "explicit-consent" },
          },
          union: {
            basis: "legal-obligation",
            retention: "6y",
            ...said,
            special: {
              kinds: ["trade-union-membership"],
              condition: "employment-and-social-protection",
            },
          },
          record: {
            basis: "public-task",
            retention: "6y",
            ...said,
            criminal: { authority: "official-authority" },
          },
        },
        automatedDecisions: {
          triage: {
            ...scoring,
            categories: ["care"],
            ground: "explicit-consent",
            measures: "A nurse reviews it",
          },
        },
      } as unknown as PersonalDataModule,
      retention: null,
    });
    const told = personalDataInformation({
      categories: special,
      keys: [key("care", null)],
      person: null,
    });
    expect(told.categories.care).toMatchObject({
      basis: "vital-interests",
      special: { kinds: ["health"], condition: "explicit-consent" },
      criminal: null,
    });
    expect(told.categories.union?.special?.condition).toBe("employment-and-social-protection");
    expect(told.categories.record).toMatchObject({
      special: null,
      criminal: { authority: "official-authority" },
    });
    expect(told.rights.map(({ right, categories: reached }) => [right, reached])).toEqual([
      ["access", null],
      ["rectification", null],
      ["erasure", ["default", "care"]],
      ["restriction", null],
      ["portability", ["care"]],
      ["objection", ["record"]],
      ["withdraw-consent", ["care"]],
      ["human-intervention", ["care"]],
      ["complaint", null],
    ]);
    expect(told.automatedDecisions).toEqual([
      {
        name: "triage",
        ...scoring,
        categories: ["care"],
        ground: "explicit-consent",
        measures: "A nurse reviews it",
      },
    ]);
  });

  it("tells the purposes the GDPR has rules for and the exemptions that keep a category past erasure, and the objections each purpose opens", () => {
    const special = (condition: string) => ({ kinds: ["health"], condition });
    const purposed = buildPersonalCategories({
      module: {
        categories: {
          news: { basis: "consent", retention: "1y", ...said, processedFor: ["direct-marketing"] },
          offers: {
            basis: "legitimate-interests",
            retention: "1y",
            ...said,
            processedFor: ["direct-marketing"],
          },
          study: {
            basis: "legitimate-interests",
            retention: "1y",
            ...said,
            processedFor: ["scientific-or-historical-research"],
            erasureExemption: "archiving-research-or-statistics",
          },
          survey: { basis: "contract", retention: "1y", ...said, processedFor: ["statistics"] },
          census: { basis: "public-task", retention: "1y", ...said, processedFor: ["statistics"] },
          archive: {
            basis: "contract",
            retention: "1y",
            ...said,
            processedFor: ["archiving-in-the-public-interest"],
          },
          lab: { basis: "contract", retention: "1y", ...said, special: special("public-health") },
          dispute: {
            basis: "contract",
            retention: "1y",
            ...said,
            special: special("legal-claims"),
          },
        },
        automatedDecisions: {},
      } as unknown as PersonalDataModule,
      retention: null,
    });
    const told = personalDataInformation({ categories: purposed, keys: [], person: null });
    expect(told.categories.news).toMatchObject({
      processedFor: ["direct-marketing"],
      erasureExemptions: [],
    });
    expect(told.categories.study).toMatchObject({
      processedFor: ["scientific-or-historical-research"],
      erasureExemptions: [{ exemption: "archiving-research-or-statistics", article: "17(3)(d)" }],
    });
    expect(told.categories.census?.erasureExemptions).toEqual([
      { exemption: "public-task", article: "17(3)(b)" },
    ]);
    expect(told.categories.lab?.erasureExemptions).toEqual([
      { exemption: "public-health", article: "17(3)(c)" },
    ]);
    expect(told.categories.dispute?.erasureExemptions).toEqual([
      { exemption: "legal-claims", article: "17(3)(e)" },
    ]);
    expect(told.rights).toEqual([
      { right: "access", article: "15", categories: null },
      { right: "rectification", article: "16", categories: null },
      {
        right: "erasure",
        article: "17",
        categories: ["default", "news", "offers", "survey", "archive"],
      },
      { right: "restriction", article: "18", categories: null },
      {
        right: "portability",
        article: "20",
        categories: ["news", "survey", "archive", "lab", "dispute"],
      },
      { right: "objection", article: "21(1)", categories: ["offers", "study", "census"] },
      { right: "objection-to-direct-marketing", article: "21(2)", categories: ["news", "offers"] },
      {
        right: "objection-to-research-or-statistics",
        article: "21(6)",
        categories: ["study", "survey"],
      },
      { right: "withdraw-consent", article: "7(3)", categories: ["news"] },
      { right: "complaint", article: "77", categories: null },
    ]);
  });

  it("leaves out the rights that reach none of the app's categories, and decisions on what they do not hold", () => {
    const plain = buildPersonalCategories({
      module: {
        categories: { invoices: { basis: "legal-obligation", retention: "6y", ...said } },
        automatedDecisions: {
          vetting: { ...scoring, categories: ["invoices"], ground: "explicit-consent" },
        },
      } as unknown as PersonalDataModule,
      retention: null,
    });
    const { rights, automatedDecisions } = personalDataInformation({
      categories: plain,
      keys: [],
      person: null,
    });
    expect(rights.map(({ right, categories: reached }) => [right, reached])).toEqual([
      ["access", null],
      ["rectification", null],
      ["erasure", ["default"]],
      ["restriction", null],
      ["objection", []],
      ["complaint", null],
    ]);
    expect(automatedDecisions).toEqual([]);
  });
});
