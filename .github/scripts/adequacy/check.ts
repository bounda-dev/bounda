// Reads the Commission's page and holds it against what Bounda expects: the lines a run prints,
// with GitHub's annotations, the summary of its job, and whether it fails.
import { compareDecisions, describeDrift, type ExpectedDecisions } from "./compare.ts";
import { type NameIndex, readEntry } from "./entry.ts";
import {
  type ActStatus,
  OPEN_END,
  readActsInForce,
  readStatuses,
  UnreadableSourceError,
} from "./eurlex.ts";
import {
  compareInForce,
  describeInForceDrift,
  describeInForceNotice,
  type InForceExpected,
} from "./in-force.ts";
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

export interface CheckInForceArgs {
  // EUR-Lex's answers to `statusQuery` and to `ACTS_IN_FORCE_QUERY`.
  readonly statuses: string;
  readonly actsInForce: string;
  readonly expected: InForceExpected;
  // The day of the run, `YYYY-MM-DD`.
  readonly today: string;
}

export interface CheckInForceFunction {
  (args: CheckInForceArgs): AdequacyCheck;
}

// A workflow command's message is one line: GitHub reads `%`, CR and LF as escapes.
const annotation = (title: string, message: string, level: "error" | "warning" = "error"): string =>
  `::${level} title=${title}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;

const PAGE_HEADING = "## Adequacy decisions";
const EUR_LEX_HEADING = "## Adequacy decisions on EUR-Lex";

const failure = (title: string, message: string, heading = PAGE_HEADING): AdequacyCheck => ({
  failed: true,
  lines: [annotation(title, message)],
  summary: `${heading}\n\n${message}\n`,
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
      summary: `${PAGE_HEADING}\n\n${read}\n\nADEQUATE_COUNTRIES, ORGANISATIONS and SCOPES match it.\n`,
    };
  }
  return {
    failed: true,
    lines: [read, ...drifts.map((drift) => annotation("Adequacy decisions drifted", drift))],
    summary: `${PAGE_HEADING}\n\n${read}\n\nThey differ from Bounda's:\n\n\`\`\`diff\n${drifts.join("\n")}\n\`\`\`\n`,
  };
};

export const eurLexFetchFailed: FetchFailedFunction = (message) =>
  failure(
    "EUR-Lex unreachable",
    `EUR-Lex's record of the adequacy decisions could not be checked: ${message}.`,
    EUR_LEX_HEADING,
  );

export const checkInForce: CheckInForceFunction = ({ statuses, actsInForce, expected, today }) => {
  let read: readonly ActStatus[];
  let compared: ReturnType<typeof compareInForce>;
  try {
    read = readStatuses(statuses);
    compared = compareInForce({
      statuses: read,
      actsInForce: readActsInForce(actsInForce),
      expected,
      today,
    });
  } catch (error) {
    if (!(error instanceof UnreadableSourceError)) throw error;
    return failure(
      "EUR-Lex unreadable",
      `EUR-Lex's record of the adequacy decisions could not be read: ${error.message}. Query it by hand and update .github/scripts/adequacy/eurlex.ts if its answer changed.`,
      EUR_LEX_HEADING,
    );
  }
  const drifts = compared.drifts.map(describeInForceDrift);
  const notices = compared.notices.map(describeInForceNotice);
  const warned = notices.map((notice) => annotation("Adequacy decision ending", notice, "warning"));
  const ending =
    notices.length === 0
      ? ""
      : `\n\nEnding soon:\n\n${notices.map((notice) => `- ${notice}`).join("\n")}`;
  if (drifts.length === 0) {
    const bounded = read
      .filter(({ endOfValidity }) => endOfValidity !== null && endOfValidity !== OPEN_END)
      .map(({ celex, endOfValidity }) => `${celex} until ${endOfValidity}`);
    const line = `EUR-Lex has the ${Object.keys(expected.decisions).length} decisions of DECISIONS in force on ${today}${bounded.length === 0 ? "" : ` (${bounded.join(", ")})`}, and no other act in force that reads as one but those of OTHER_ACTS.`;
    return {
      failed: false,
      lines: [line, ...warned],
      summary: `${EUR_LEX_HEADING}\n\n${line}${ending}\n`,
    };
  }
  return {
    failed: true,
    lines: [
      ...drifts.map((drift) => annotation("Adequacy decisions drifted on EUR-Lex", drift)),
      ...warned,
    ],
    summary: `${EUR_LEX_HEADING}\n\nEUR-Lex differs from Bounda's decisions:\n\n\`\`\`diff\n${drifts.join("\n")}\n\`\`\`${ending}\n`,
  };
};
