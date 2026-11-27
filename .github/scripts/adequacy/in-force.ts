// Holds EUR-Lex's record of the adequacy decisions against those Bounda rests on: a decision
// repealed, annulled or expired before the Commission's page says so, and an act in force that
// reads as a decision Bounda does not know, a new one, a renewal or an amendment.

import type { CountryCode } from "../../../packages/core/src/modules/recipient.ts";
import { countryName } from "./entry.ts";
import type { ActInForce, ActStatus } from "./eurlex.ts";

export interface InForceExpected {
  // By the code of the country, or the name of the organisation, it covers.
  readonly decisions: Readonly<Record<string, string>>;
  // Acts whose title reads as an adequacy decision and are none of the list, by CELEX number.
  readonly otherActs: Readonly<Record<string, string>>;
}

export type InForceDrift =
  | { readonly kind: "missing"; readonly label: string; readonly celex: string }
  | {
      readonly kind: "ended";
      readonly label: string;
      readonly organisation: boolean;
      readonly celex: string;
      // `null` when EUR-Lex marks the decision no longer in force.
      readonly endedOn: string | null;
    }
  | { readonly kind: "unseen"; readonly label: string; readonly celex: string }
  | { readonly kind: "unknown"; readonly celex: string; readonly title: string };

export interface InForceNotice {
  readonly label: string;
  readonly organisation: boolean;
  readonly celex: string;
  readonly endOfValidity: string;
  readonly days: number;
}

export interface CompareInForceArgs {
  readonly statuses: readonly ActStatus[];
  readonly actsInForce: readonly ActInForce[];
  readonly expected: InForceExpected;
  // The day of the run, `YYYY-MM-DD`.
  readonly today: string;
}

export interface CompareInForceFunction {
  (
    args: CompareInForceArgs,
  ): {
    readonly drifts: readonly InForceDrift[];
    readonly notices: readonly InForceNotice[];
  };
}

export interface DescribeInForceDriftFunction {
  (drift: InForceDrift): string;
}

export interface DescribeInForceNoticeFunction {
  (notice: InForceNotice): string;
}

// Long enough for a renewal to be adopted after the warning, as the United Kingdom's were.
export const ENDING_WITHIN_DAYS = 180;

const DAY_MS = 86_400_000;

// `DECISIONS` keys a country by its code, an organisation by its name.
const isCountry = (key: string): key is CountryCode => /^[A-Z]{2}$/.test(key);

const labelOf = (key: string): string => (isCountry(key) ? `${countryName(key)} (${key})` : key);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const compareInForce: CompareInForceFunction = ({
  statuses,
  actsInForce,
  expected,
  today,
}) => {
  const drifts: InForceDrift[] = [];
  const notices: InForceNotice[] = [];
  const byCelex = new Map(statuses.map((status) => [status.celex, status]));
  const found = new Set(actsInForce.map(({ celex }) => celex));
  for (const [key, celex] of Object.entries(expected.decisions)) {
    const label = labelOf(key);
    const organisation = !isCountry(key);
    const status = byCelex.get(celex);
    if (status === undefined) {
      drifts.push({ kind: "missing", label, celex });
      continue;
    }
    const { endOfValidity } = status;
    if (!status.inForce) {
      drifts.push({ kind: "ended", label, organisation, celex, endedOn: null });
      continue;
    }
    if (endOfValidity !== null && endOfValidity <= today) {
      drifts.push({ kind: "ended", label, organisation, celex, endedOn: endOfValidity });
      continue;
    }
    if (!found.has(celex)) drifts.push({ kind: "unseen", label, celex });
    if (endOfValidity === null) continue;
    const days = daysBetween(today, endOfValidity);
    if (days <= ENDING_WITHIN_DAYS)
      notices.push({ label, organisation, celex, endOfValidity, days });
  }
  const known = new Set([...Object.values(expected.decisions), ...Object.keys(expected.otherActs)]);
  for (const act of actsInForce) {
    if (!known.has(act.celex)) drifts.push({ kind: "unknown", ...act });
  }
  return { drifts, notices };
};

const dropIt = (organisation: boolean): string =>
  organisation
    ? "drop it from ORGANISATIONS"
    : "drop it from ADEQUATE_COUNTRIES, and from PARTIAL_ADEQUACY if it is there";

const drop = (organisation: boolean): string =>
  `${dropIt(organisation)}, or, if another decision replaced it, name that one in DECISIONS`;

export const describeInForceDrift: DescribeInForceDriftFunction = (drift) => {
  switch (drift.kind) {
    case "missing":
      return `- ${drift.label} ${drift.celex}: EUR-Lex has no act ${drift.celex}; check its CELEX number in DECISIONS`;
    case "ended":
      return drift.endedOn === null
        ? `- ${drift.label} ${drift.celex}: EUR-Lex has the decision no longer in force; ${drop(drift.organisation)}`
        : `- ${drift.label} ${drift.celex}: EUR-Lex ends the decision's validity on ${drift.endedOn}; ${drop(drift.organisation)}`;
    case "unseen":
      return `? ${drift.label} ${drift.celex}: EUR-Lex has the decision in force, and ACTS_IN_FORCE_QUERY no longer finds it, so it could miss a new decision too; fix the query in .github/scripts/adequacy/eurlex.ts`;
    case "unknown":
      return `+ ${drift.celex} "${drift.title}": EUR-Lex has it in force and it reads as an adequacy decision, which neither DECISIONS nor OTHER_ACTS names; read it, then add it to DECISIONS, with ADEQUATE_COUNTRIES, if it is a decision of the list, or to OTHER_ACTS with what it does`;
  }
};

export const describeInForceNotice: DescribeInForceNoticeFunction = ({
  label,
  organisation,
  celex,
  endOfValidity,
  days,
}) =>
  `${label} ${celex}: EUR-Lex ends the decision's validity on ${endOfValidity}, in ${days} days; without a renewal by then, ${dropIt(organisation)}`;
