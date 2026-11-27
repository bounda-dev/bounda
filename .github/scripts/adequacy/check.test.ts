import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES } from "../../../packages/core/src/modules/recipient.ts";
import { checkAdequacy, checkInForce, eurLexFetchFailed, fetchFailed } from "./check.ts";
import { nameIndex } from "./entry.ts";
import { ALIASES, DECISIONS, ORGANISATIONS, OTHER_ACTS, SCOPES } from "./expected.ts";

const page = readFileSync(new URL("fixtures/adequacy-decisions.html", import.meta.url), "utf8");
const url = "https://commission.example/adequacy";
const index = nameIndex({
  countries: COUNTRY_CODES,
  aliases: ALIASES,
  organisations: ORGANISATIONS,
});
const expected = { countries: ADEQUATE_COUNTRIES, organisations: ORGANISATIONS, scopes: SCOPES };

describe("checkAdequacy", () => {
  it("passes on the Commission's page as Bounda knows it, saying what it read", () => {
    const check = checkAdequacy({ html: page, url, index, expected });
    expect(check.failed).toBe(false);
    expect(check.lines).toHaveLength(2);
    expect(check.lines[0]).toMatch(
      /^The Commission lists 17 entries at https:\/\/commission\.example\/adequacy: Andorra; .*; European Patent Organisation\.$/,
    );
    expect(check.lines[1]).toBe("ADEQUATE_COUNTRIES, ORGANISATIONS and SCOPES match it.");
    expect(check.summary).toBe(
      `## Adequacy decisions\n\n${check.lines[0]}\n\nADEQUATE_COUNTRIES, ORGANISATIONS and SCOPES match it.\n`,
    );
  });

  it("fails on every drift, each as an annotation and as a line of the summary's diff", () => {
    const html = page
      .replace(/<li>(?:(?!<\/li>)[\s\S])*Israel<\/a>,<\/li>/, "")
      .replace(/<li>(?=<a[^>]*>Uruguay)/, "<li>Kenya (100%\nsure)</li><li>");
    const check = checkAdequacy({ html, url, index, expected });
    expect(check.failed).toBe(true);
    expect(check.lines.slice(1)).toEqual([
      "::error title=Adequacy decisions drifted::+ Kenya (KE) (100%25 sure): the Commission lists it, missing from ADEQUATE_COUNTRIES, its scope from SCOPES",
      "::error title=Adequacy decisions drifted::- Israel (IL): in ADEQUATE_COUNTRIES, and the Commission no longer lists it",
    ]);
    expect(check.summary).toContain(
      "They differ from Bounda's:\n\n```diff\n+ Kenya (KE) (100% sure): the Commission lists it, missing from ADEQUATE_COUNTRIES, its scope from SCOPES\n- Israel (IL): in ADEQUATE_COUNTRIES, and the Commission no longer lists it\n```\n",
    );
  });

  it("fails on a page it cannot read, saying why and where to fix it", () => {
    const html = "<html><head><title>\n  Just a moment\n</title></head></html>";
    const check = checkAdequacy({ html, url, index, expected });
    const message = `The Commission's adequacy page could not be read: it no longer says which countries the Commission "has so far recognised" (received ${html.length} characters titled "Just a moment"). Read ${url} and update .github/scripts/adequacy/page.ts if its markup changed.`;
    expect(check).toEqual({
      failed: true,
      lines: [`::error title=Adequacy page unreadable::${message}`],
      summary: `## Adequacy decisions\n\n${message}\n`,
    });
    expect(checkAdequacy({ html: "<p>x</p>", url, index, expected }).summary).toContain(
      "(received 8 characters, untitled)",
    );
    expect(checkAdequacy({ html: "<title> </title>", url, index, expected }).summary).toContain(
      "(received 16 characters, untitled)",
    );
  });
});

describe("fetchFailed", () => {
  it("fails with the reason the page could not be fetched", () => {
    const message = `The Commission's adequacy page could not be checked: ${url} could not be fetched: the server answered 503.`;
    expect(fetchFailed(`${url} could not be fetched: the server answered 503`)).toEqual({
      failed: true,
      lines: [`::error title=Adequacy page unreachable::${message}`],
      summary: `## Adequacy decisions\n\n${message}\n`,
    });
  });
});

describe("checkInForce", () => {
  const fixture = (name: string): string =>
    readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
  const statuses = fixture("eurlex-statuses.json");
  const actsInForce = fixture("eurlex-acts-in-force.json");
  const decisions = { decisions: DECISIONS, otherActs: OTHER_ACTS };
  const read =
    "EUR-Lex has the 17 decisions of DECISIONS in force on 2026-11-26 (32021D1772 until 2031-12-27), and no other act in force that reads as one but those of OTHER_ACTS.";

  it("passes on EUR-Lex's record as Bounda knows it, saying what it read", () => {
    expect(
      checkInForce({ statuses, actsInForce, expected: decisions, today: "2026-11-26" }),
    ).toEqual({
      failed: false,
      lines: [read],
      summary: `## Adequacy decisions on EUR-Lex\n\n${read}\n`,
    });
  });

  it("warns of a decision whose validity ends soon, without failing", () => {
    const check = checkInForce({
      statuses,
      actsInForce,
      expected: decisions,
      today: "2031-11-27",
    });
    const notice =
      "United Kingdom (GB) 32021D1772: EUR-Lex ends the decision's validity on 2031-12-27, in 30 days; without a renewal by then, drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there";
    expect(check.failed).toBe(false);
    expect(check.lines.slice(1)).toEqual([`::warning title=Adequacy decision ending::${notice}`]);
    expect(check.summary).toContain(`\n\nEnding soon:\n\n- ${notice}\n`);
  });

  it("fails on every drift, each as an annotation and as a line of the summary's diff", () => {
    const repealed = statuses.replace(
      /("value": "32023D1795" }\s*, "inForce": \{[^}]*"value": )"1"/,
      '$1"0"',
    );
    expect(repealed).not.toBe(statuses);
    const check = checkInForce({
      statuses: repealed,
      actsInForce,
      expected: { decisions: DECISIONS, otherActs: {} },
      today: "2031-12-27",
    });
    expect(check.failed).toBe(true);
    expect(check.lines).toContain(
      "::error title=Adequacy decisions drifted on EUR-Lex::- United States (US) 32023D1795: EUR-Lex has the decision no longer in force; drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there, or, if another decision replaced it, name that one in DECISIONS",
    );
    expect(check.lines).toContain(
      "::error title=Adequacy decisions drifted on EUR-Lex::- United Kingdom (GB) 32021D1772: EUR-Lex ends the decision's validity on 2031-12-27; drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there, or, if another decision replaced it, name that one in DECISIONS",
    );
    expect(check.lines.filter((line) => line.includes("::+ 3"))).toHaveLength(
      Object.keys(OTHER_ACTS).length,
    );
    expect(check.summary).toMatch(
      /^## Adequacy decisions on EUR-Lex\n\nEUR-Lex differs from Bounda's decisions:\n\n```diff\n- United Kingdom \(GB\) 32021D1772: [^\n]*\n- United States \(US\) 32023D1795: [^\n]*\n(\+ 3[^\n]*\n)+```\n$/,
    );
  });

  it("fails on an answer it cannot read, saying why and where to fix it", () => {
    const message =
      "EUR-Lex's record of the adequacy decisions could not be read: its answer is no JSON. Query it by hand and update .github/scripts/adequacy/eurlex.ts if its answer changed.";
    const unreadable = {
      failed: true,
      lines: [`::error title=EUR-Lex unreadable::${message}`],
      summary: `## Adequacy decisions on EUR-Lex\n\n${message}\n`,
    };
    for (const answers of [
      { statuses: "<html/>", actsInForce },
      { statuses, actsInForce: "<html/>" },
    ]) {
      expect(checkInForce({ ...answers, expected: decisions, today: "2026-11-26" })).toEqual(
        unreadable,
      );
    }
  });
});

describe("eurLexFetchFailed", () => {
  it("fails with the reason EUR-Lex could not be fetched", () => {
    const message =
      "EUR-Lex's record of the adequacy decisions could not be checked: https://publications.europa.eu/webapi/rdf/sparql could not be fetched: the server answered 503.";
    expect(
      eurLexFetchFailed(
        "https://publications.europa.eu/webapi/rdf/sparql could not be fetched: the server answered 503",
      ),
    ).toEqual({
      failed: true,
      lines: [`::error title=EUR-Lex unreachable::${message}`],
      summary: `## Adequacy decisions on EUR-Lex\n\n${message}\n`,
    });
  });
});
