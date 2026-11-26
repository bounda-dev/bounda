import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES } from "../../../packages/core/src/modules/recipient.ts";
import { checkAdequacy, fetchFailed } from "./check.ts";
import { nameIndex } from "./entry.ts";
import { ALIASES, ORGANISATIONS, SCOPES } from "./expected.ts";

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
