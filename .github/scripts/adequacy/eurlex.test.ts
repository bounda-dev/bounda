import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACTS_IN_FORCE_QUERY,
  OPEN_END,
  queryUrl,
  readActsInForce,
  readStatuses,
  SPARQL_ENDPOINT,
  statusQuery,
  UnreadableSourceError,
} from "./eurlex.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

const answer = (vars: readonly string[], ...bindings: readonly unknown[]): string =>
  JSON.stringify({ head: { vars }, results: { bindings } });

const literal = (value: string) => ({ type: "literal", value });

const status = (celex: string, inForce?: string, end?: string) => ({
  celex: literal(celex),
  ...(inForce === undefined ? {} : { inForce: literal(inForce) }),
  ...(end === undefined ? {} : { end: literal(end) }),
});

const STATUS_VARS = ["celex", "inForce", "end"];

describe("statusQuery", () => {
  it("asks for the in-force status and end of validity of each decision by its CELEX number", () => {
    const query = statusQuery(["32023D1795", "32002D0002"]);
    expect(query).toContain('FILTER(STR(?celex) IN ("32023D1795", "32002D0002"))');
    expect(query).toContain("OPTIONAL { ?work cdm:resource_legal_in-force ?inForce }");
    expect(query).toContain("OPTIONAL { ?work cdm:resource_legal_date_end-of-validity ?end }");
  });

  it("refuses anything that is no CELEX number of a decision, which would change the query", () => {
    for (const celex of ['32023D1795") || true || ("', "32016R0679", "3202D1795"]) {
      expect(() => statusQuery([celex])).toThrow(
        new TypeError(`${celex} is no CELEX number of a decision`),
      );
    }
  });
});

describe("queryUrl", () => {
  it("sends the query to the Publications Office's SPARQL endpoint", () => {
    const url = new URL(queryUrl(ACTS_IN_FORCE_QUERY));
    expect(`${url.origin}${url.pathname}`).toBe(SPARQL_ENDPOINT);
    expect(url.searchParams.get("query")).toBe(ACTS_IN_FORCE_QUERY);
  });
});

describe("readStatuses", () => {
  it("reads EUR-Lex's answer for every decision Bounda rests on", () => {
    const statuses = readStatuses(fixture("eurlex-statuses.json"));
    expect(statuses).toHaveLength(17);
    expect(statuses.find(({ celex }) => celex === "32023D1795")).toEqual({
      celex: "32023D1795",
      inForce: true,
      endOfValidity: OPEN_END,
    });
    expect(statuses.find(({ celex }) => celex === "32021D1772")).toEqual({
      celex: "32021D1772",
      inForce: true,
      endOfValidity: "2031-12-27",
    });
  });

  it("reads in force as 1 or true, and no longer as 0 or false, with or without an end", () => {
    expect(
      readStatuses(
        answer(
          STATUS_VARS,
          status("32016D1250", "0", "2016-07-12"),
          status("32000D0520", "false"),
          status("32023D1795", "true"),
          status("32002D0002", "1", "9999-12-31"),
        ),
      ),
    ).toEqual([
      { celex: "32016D1250", inForce: false, endOfValidity: "2016-07-12" },
      { celex: "32000D0520", inForce: false, endOfValidity: null },
      { celex: "32023D1795", inForce: true, endOfValidity: null },
      { celex: "32002D0002", inForce: true, endOfValidity: OPEN_END },
    ]);
  });

  it("reads a work given twice alike as one", () => {
    const twice = status("32023D1795", "1", OPEN_END);
    expect(readStatuses(answer(STATUS_VARS, twice, twice))).toEqual([
      { celex: "32023D1795", inForce: true, endOfValidity: OPEN_END },
    ]);
  });

  it.each([
    ["not JSON", "<html>Service unavailable</html>", "its answer is no JSON"],
    [
      "no results",
      JSON.stringify({ head: { vars: STATUS_VARS } }),
      "its answer holds no SPARQL results",
    ],
    [
      "no head",
      JSON.stringify({ results: { bindings: [] } }),
      "its answer holds no SPARQL results",
    ],
    ["a JSON array", "[]", "its answer holds no SPARQL results"],
    ["a variable missing", answer(["celex", "inForce"]), "its answer has no variable end"],
    [
      "a row that is no object",
      answer(STATUS_VARS, "32023D1795"),
      "its answer holds a row that is no object",
    ],
    [
      "a row without its CELEX",
      answer(STATUS_VARS, { inForce: literal("1") }),
      "its answer holds a row without celex",
    ],
    [
      "a term that is no literal",
      answer(STATUS_VARS, { celex: { type: "uri" } }),
      "its answer holds a celex that is no literal",
    ],
    [
      "a CELEX of no decision",
      answer(STATUS_VARS, status("32016R0679", "1")),
      'its answer holds "32016R0679", no CELEX number of a decision',
    ],
    [
      "no in-force status",
      answer(STATUS_VARS, status("32023D1795")),
      "it says nothing of whether 32023D1795 is in force",
    ],
    [
      "another in-force status",
      answer(STATUS_VARS, status("32023D1795", "yes")),
      'it says 32023D1795 is in force "yes", neither true nor false',
    ],
    [
      "an end that is no date",
      answer(STATUS_VARS, status("32023D1795", "1", "31.12.9999")),
      'it ends the validity of 32023D1795 on "31.12.9999", no date',
    ],
    [
      "two statuses of one work",
      answer(STATUS_VARS, status("32023D1795", "1"), status("32023D1795", "0")),
      "it gives 32023D1795 two statuses",
    ],
    [
      "two ends of one work",
      answer(
        STATUS_VARS,
        status("32023D1795", "1", OPEN_END),
        status("32023D1795", "1", "2026-01-01"),
      ),
      "it gives 32023D1795 two statuses",
    ],
  ])("fails as unreadable on %s", (_, body, message) => {
    expect(() => readStatuses(body)).toThrow(new UnreadableSourceError(message));
  });
});

describe("readActsInForce", () => {
  it("reads every act in force EUR-Lex finds reading as an adequacy decision, once each", () => {
    const acts = readActsInForce(fixture("eurlex-acts-in-force.json"));
    expect(acts.map(({ celex }) => celex)).toContain("32023D1795");
    expect(acts.map(({ celex }) => celex)).toContain("32010D0146");
    expect(new Set(acts.map(({ celex }) => celex)).size).toBe(acts.length);
    expect(acts.find(({ celex }) => celex === "32026D0179")?.title).toMatch(
      /^Commission Implementing Decision \(EU\) 2026\/179 of 26 January 2026 .* by Brazil/,
    );
  });

  it("folds the spaces of a title, and keeps the first of a work's titles", () => {
    expect(
      readActsInForce(
        answer(
          ["celex", "title"],
          { celex: literal("32023D1795"), title: literal("  Implementing\n Decision  ") },
          { celex: literal("32023D1795"), title: literal("Another title") },
        ),
      ),
    ).toEqual([{ celex: "32023D1795", title: "Implementing Decision" }]);
  });

  it("fails as unreadable when it finds none, or a row without its title", () => {
    expect(() => readActsInForce(answer(["celex", "title"]))).toThrow(
      new UnreadableSourceError("it finds no act in force that reads as an adequacy decision"),
    );
    expect(() =>
      readActsInForce(answer(["celex", "title"], { celex: literal("32023D1795") })),
    ).toThrow(new UnreadableSourceError("its answer holds a row without title"));
    expect(() => readActsInForce(answer(["celex"]))).toThrow(
      new UnreadableSourceError("its answer has no variable title"),
    );
  });
});
