// Holds `ADEQUATE_COUNTRIES` against the European Commission's list of adequacy decisions, and
// each decision against EUR-Lex's record of it, and fails on any difference:
// `node .github/scripts/adequacy-check.ts [page.html [statuses.json acts-in-force.json]]`, which
// reads each source from its file when one is given and fetches it otherwise.
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES } from "../../packages/core/src/modules/recipient.ts";
import {
  type AdequacyCheck,
  checkAdequacy,
  checkInForce,
  eurLexFetchFailed,
  fetchFailed,
} from "./adequacy/check.ts";
import { nameIndex } from "./adequacy/entry.ts";
import { ACTS_IN_FORCE_QUERY, queryUrl, SPARQL_RESULTS, statusQuery } from "./adequacy/eurlex.ts";
import { ALIASES, DECISIONS, ORGANISATIONS, OTHER_ACTS, SCOPES } from "./adequacy/expected.ts";
import { fetchPage, PageFetchError } from "./adequacy/fetch.ts";

const URL =
  "https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en";

const [pageFile, statusesFile, actsFile] = process.argv.slice(2);

const fetched = (url: string, accept: string): Promise<string> =>
  fetchPage({
    url,
    accept,
    fetch,
    wait: async (milliseconds) => {
      await setTimeout(milliseconds);
    },
    attempts: 3,
    timeoutMs: 60_000,
  });

const readPage = async (): Promise<AdequacyCheck> => {
  let html: string;
  try {
    html =
      pageFile === undefined ? await fetched(URL, "text/html") : readFileSync(pageFile, "utf8");
  } catch (error) {
    if (error instanceof PageFetchError) return fetchFailed(error.message);
    throw error;
  }
  return checkAdequacy({
    html,
    url: URL,
    index: nameIndex({ countries: COUNTRY_CODES, aliases: ALIASES, organisations: ORGANISATIONS }),
    expected: { countries: ADEQUATE_COUNTRIES, organisations: ORGANISATIONS, scopes: SCOPES },
  });
};

const readEurLex = async (): Promise<AdequacyCheck> => {
  let statuses: string;
  let actsInForce: string;
  try {
    [statuses, actsInForce] =
      statusesFile === undefined || actsFile === undefined
        ? await Promise.all([
            fetched(queryUrl(statusQuery(Object.values(DECISIONS))), SPARQL_RESULTS),
            fetched(queryUrl(ACTS_IN_FORCE_QUERY), SPARQL_RESULTS),
          ])
        : [readFileSync(statusesFile, "utf8"), readFileSync(actsFile, "utf8")];
  } catch (error) {
    if (error instanceof PageFetchError) return eurLexFetchFailed(error.message);
    throw error;
  }
  return checkInForce({
    statuses,
    actsInForce,
    expected: { decisions: DECISIONS, otherActs: OTHER_ACTS },
    today: new Date().toISOString().slice(0, 10),
  });
};

const checks = await Promise.all([readPage(), readEurLex()]);
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
for (const { lines, summary } of checks) {
  process.stdout.write(`${lines.join("\n")}\n`);
  if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, `${summary}\n`);
}
if (checks.some(({ failed }) => failed)) process.exitCode = 1;
