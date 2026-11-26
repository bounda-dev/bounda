// Reads the Commission's page and holds it against what Bounda expects: the lines a run prints,
// with GitHub's annotations, the summary of its job, and whether it fails.
import { compareDecisions, describeDrift, type ExpectedDecisions } from "./compare.ts";
import { type NameIndex, readEntry } from "./entry.ts";
import { readAdequacyList, UnreadablePageError } from "./page.ts";

export interface CheckAdequacyArgs {
  readonly html: string;
  readonly url: string;
  readonly index: NameIndex;
  readonly expected: ExpectedDecisions;
}

export interface AdequacyCheck {
  readonly failed: boolean;
  readonly lines: readonly string[];
  readonly summary: string;
}

export interface CheckAdequacyFunction {
  (args: CheckAdequacyArgs): AdequacyCheck;
}

export interface FetchFailedFunction {
  (message: string): AdequacyCheck;
}

// A workflow command's message is one line: GitHub reads `%`, CR and LF as escapes.
const annotation = (title: string, message: string): string =>
  `::error title=${title}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;

const failure = (title: string, message: string): AdequacyCheck => ({
  failed: true,
  lines: [annotation(title, message)],
  summary: `## Adequacy decisions\n\n${message}\n`,
});

// What arrived, so that a page served in its place (an error, a challenge) is told apart from a
// page whose markup changed.
const received = (html: string): string => {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i
    .exec(html)?.[1]
    ?.replace(/\s+/g, " ")
    .trim();
  return `${html.length} characters${title === undefined || title === "" ? ", untitled" : ` titled "${title}"`}`;
};

export const fetchFailed: FetchFailedFunction = (message) =>
  failure(
    "Adequacy page unreachable",
    `The Commission's adequacy page could not be checked: ${message}.`,
  );

export const checkAdequacy: CheckAdequacyFunction = ({ html, url, index, expected }) => {
  let entries: readonly string[];
  try {
    entries = readAdequacyList(html);
  } catch (error) {
    if (!(error instanceof UnreadablePageError)) throw error;
    return failure(
      "Adequacy page unreadable",
      `The Commission's adequacy page could not be read: ${error.message} (received ${received(html)}). Read ${url} and update .github/scripts/adequacy/page.ts if its markup changed.`,
    );
  }
  const drifts = compareDecisions({
    listed: entries.map((text) => readEntry(text, index)),
    expected,
  }).map(describeDrift);
  const read = `The Commission lists ${entries.length} entries at ${url}: ${entries.join("; ")}.`;
  if (drifts.length === 0) {
    return {
      failed: false,
      lines: [read, "ADEQUATE_COUNTRIES, ORGANISATIONS and SCOPES match it."],
      summary: `## Adequacy decisions\n\n${read}\n\nADEQUATE_COUNTRIES, ORGANISATIONS and SCOPES match it.\n`,
    };
  }
  return {
    failed: true,
    lines: [read, ...drifts.map((drift) => annotation("Adequacy decisions drifted", drift))],
    summary: `## Adequacy decisions\n\n${read}\n\nThey differ from Bounda's:\n\n\`\`\`diff\n${drifts.join("\n")}\n\`\`\`\n`,
  };
};
