import { describe, expect, it } from "vitest";
import type { GenerateReport } from "./generate/generate.ts";
import { ConventionError } from "./generate/problems.ts";
import { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";

const report = (overrides: Partial<GenerateReport>): GenerateReport => ({
  model: { root: "/p", appDir: "app", aggregates: [], readModels: [] },
  files: [],
  written: [],
  unchanged: [],
  removed: [],
  warnings: [],
  ...overrides,
});

describe("formatReport", () => {
  it("lists written and removed files relative to the root, then the summary", () => {
    const text = formatReport({
      root: "/p",
      report: report({
        model: {
          root: "/p",
          appDir: "app",
          aggregates: [{} as never],
          readModels: [{} as never, {} as never],
        },
        files: [{} as never, {} as never, {} as never],
        written: ["/p/.bounda/registry.ts", "/p/app/domain/order/+types/order-placed.ts"],
        unchanged: ["/p/.bounda/types.ts"],
        removed: ["/p/app/read/orders/+types/gone.ts"],
      }),
    });
    expect(text).toBe(
      [
        "  written  .bounda/registry.ts",
        "  written  app/domain/order/+types/order-placed.ts",
        "  removed  app/read/orders/+types/gone.ts",
        "1 aggregate, 2 read models, 3 files (2 written, 1 unchanged, 1 removed)",
      ].join("\n"),
    );
  });

  it("prints only the summary when nothing changed", () => {
    expect(formatReport({ root: "/p", report: report({}) })).toBe(
      "0 aggregates, 0 read models, 0 files (0 written, 0 unchanged, 0 removed)",
    );
  });
});

describe("formatWarnings", () => {
  it("prints one line per warning and nothing when there are none", () => {
    expect(formatWarnings(report({}))).toBe("");
    expect(
      formatWarnings(
        report({
          warnings: [
            { aggregate: "order", message: "one" },
            { aggregate: "customer", message: "two" },
          ],
        }),
      ),
    ).toBe("warning: order: one\nwarning: customer: two");
  });
});

describe("ConventionError", () => {
  it("counts its problems and names itself", () => {
    const one = new ConventionError([{ path: "/p/app/x.ts", message: "bad" }]);
    expect(one.name).toBe("ConventionError");
    expect(one.message).toBe("1 problem in the project layout:\n  /p/app/x.ts: bad");
    const two = new ConventionError([
      { path: "/p/a", message: "first" },
      { path: "/p/b", message: "second" },
    ]);
    expect(two.message).toBe("2 problems in the project layout:\n  /p/a: first\n  /p/b: second");
    expect(formatConventionError({ error: two, root: "/p" })).toBe(
      "error: 2 problems in the project layout\n  a: first\n  b: second",
    );
    expect(formatConventionError({ error: one, root: "/p" })).toBe(
      "error: 1 problem in the project layout\n  app/x.ts: bad",
    );
  });
});
