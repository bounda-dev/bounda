// Holds `ADEQUATE_COUNTRIES` against the European Commission's list of adequacy decisions and
// fails on any difference: `node .github/scripts/adequacy-check.ts [page.html]`, which reads the
// page from the file when one is given and fetches it otherwise.
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { ADEQUATE_COUNTRIES, COUNTRY_CODES } from "../../packages/core/src/modules/recipient.ts";
import { type AdequacyCheck, checkAdequacy, fetchFailed } from "./adequacy/check.ts";
import { nameIndex } from "./adequacy/entry.ts";
import { ALIASES, ORGANISATIONS, SCOPES } from "./adequacy/expected.ts";
import { fetchPage, PageFetchError } from "./adequacy/fetch.ts";

const URL =
  "https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en";

const [file] = process.argv.slice(2);
const read = async (): Promise<AdequacyCheck> => {
  let html: string;
  try {
    html =
      file === undefined
        ? await fetchPage({
            url: URL,
            fetch,
            wait: async (milliseconds) => {
              await setTimeout(milliseconds);
            },
            attempts: 3,
            timeoutMs: 60_000,
          })
        : readFileSync(file, "utf8");
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
const { failed, lines, summary } = await read();
process.stdout.write(`${lines.join("\n")}\n`);
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile !== undefined && summaryFile !== "") appendFileSync(summaryFile, summary);
if (failed) process.exitCode = 1;
