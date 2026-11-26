// Every way the Commission's list can differ from what Bounda holds, in the list's order and then
// in Bounda's, each as one line of a diff that says what to change.
import type { CountryCode } from "../../../packages/core/src/modules/recipient.ts";
import { countryName, type ListedEntry } from "./entry.ts";

export interface ExpectedDecisions {
  readonly countries: readonly CountryCode[];
  readonly organisations: readonly string[];
  readonly scopes: Readonly<Record<string, string | undefined>>;
}

export type Drift =
  | { readonly kind: "unknown"; readonly text: string }
  | { readonly kind: "duplicate"; readonly label: string }
  | {
      readonly kind: "added";
      readonly label: string;
      readonly organisation: boolean;
      readonly scope: string;
    }
  | { readonly kind: "removed"; readonly label: string; readonly organisation: boolean }
  | {
      readonly kind: "scope";
      readonly label: string;
      readonly listed: string;
      readonly expected: string;
    };

export interface CompareDecisionsArgs {
  readonly listed: readonly ListedEntry[];
  readonly expected: ExpectedDecisions;
}

export interface CompareDecisionsFunction {
  (args: CompareDecisionsArgs): readonly Drift[];
}

export interface DescribeDriftFunction {
  (drift: Drift): string;
}

const countryLabel = (code: CountryCode): string => `${countryName(code)} (${code})`;

export const compareDecisions: CompareDecisionsFunction = ({ listed, expected }) => {
  const drifts: Drift[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    if (entry.kind === "unknown") {
      drifts.push({ kind: "unknown", text: entry.text });
      continue;
    }
    const key = entry.kind === "country" ? entry.code : entry.name;
    const label = entry.kind === "country" ? countryLabel(entry.code) : entry.name;
    const organisation = entry.kind === "organisation";
    if (seen.has(key)) {
      drifts.push({ kind: "duplicate", label });
      continue;
    }
    seen.add(key);
    const known =
      entry.kind === "country"
        ? expected.countries.includes(entry.code)
        : expected.organisations.includes(entry.name);
    if (!known) {
      drifts.push({ kind: "added", label, organisation, scope: entry.scope });
      continue;
    }
    const scope = expected.scopes[key] ?? "";
    if (entry.scope !== scope)
      drifts.push({ kind: "scope", label, listed: entry.scope, expected: scope });
  }
  for (const code of expected.countries) {
    if (!seen.has(code))
      drifts.push({ kind: "removed", label: countryLabel(code), organisation: false });
  }
  for (const name of expected.organisations) {
    if (!seen.has(name)) drifts.push({ kind: "removed", label: name, organisation: true });
  }
  return drifts;
};

const listOf = ({ organisation }: { readonly organisation: boolean }): string =>
  organisation ? "ORGANISATIONS" : "ADEQUATE_COUNTRIES";

const quoted = (scope: string): string => (scope === "" ? "nothing" : `"${scope}"`);

export const describeDrift: DescribeDriftFunction = (drift) => {
  switch (drift.kind) {
    case "unknown":
      return `? "${drift.text}": the Commission lists it, and it names no country Bounda knows nor an organisation of ORGANISATIONS; add its name to ALIASES or ORGANISATIONS`;
    case "duplicate":
      return `! ${drift.label}: the Commission lists it more than once`;
    case "added":
      return drift.scope === ""
        ? `+ ${drift.label}: the Commission lists it, missing from ${listOf(drift)}`
        : `+ ${drift.label} ${drift.scope}: the Commission lists it, missing from ${listOf(drift)}, its scope from SCOPES`;
    case "removed":
      return `- ${drift.label}: in ${listOf(drift)}, and the Commission no longer lists it`;
    case "scope":
      return `~ ${drift.label}: the Commission writes ${quoted(drift.listed)} after its name, SCOPES has ${quoted(drift.expected)}`;
  }
};
