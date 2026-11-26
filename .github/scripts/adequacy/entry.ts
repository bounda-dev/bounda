// Tells what an entry of the list names: a country by its ISO code, an organisation, or nothing
// known, and the words after the name, which say what the decision covers.
import type { CountryCode } from "../../../packages/core/src/modules/recipient.ts";

export type ListedEntry =
  | {
      readonly kind: "country";
      readonly code: CountryCode;
      readonly name: string;
      readonly scope: string;
    }
  | { readonly kind: "organisation"; readonly name: string; readonly scope: string }
  | { readonly kind: "unknown"; readonly text: string };

export interface NameIndexArgs {
  readonly countries: readonly CountryCode[];
  readonly aliases: Readonly<Record<string, CountryCode>>;
  readonly organisations: readonly string[];
  // A country's names, its English ones (long and short) unless given.
  readonly namesOf?: (code: CountryCode) => readonly string[];
}

type Named =
  | { readonly kind: "country"; readonly code: CountryCode }
  | {
      readonly kind: "organisation";
      readonly name: string;
    };

export interface NameIndex {
  readonly names: ReadonlyMap<string, Named>;
  readonly longest: number;
}

export interface NameIndexFunction {
  (args: NameIndexArgs): NameIndex;
}

export interface ReadEntryFunction {
  (text: string, index: NameIndex): ListedEntry;
}

export interface CountryNameFunction {
  (code: CountryCode): string;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const shortRegionNames = new Intl.DisplayNames(["en"], { type: "region", style: "short" });

export const countryName: CountryNameFunction = (code) => regionNames.of(code) ?? code;

const englishNames = (code: CountryCode): readonly string[] => [
  countryName(code),
  shortRegionNames.of(code) ?? code,
];

// Two spellings of a name meet here: accents, apostrophes, "&", punctuation, case and a leading
// "the" do not tell names apart.
const fold = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/^the /, "");

const wordsOf = (text: string): readonly string[] => text.split(" ").filter((word) => word !== "");

// Organisations and aliases hold their names; two countries whose names meet hold neither, so an
// entry under that name comes out unknown rather than given to one of them.
export const nameIndex: NameIndexFunction = ({
  countries,
  aliases,
  organisations,
  namesOf = englishNames,
}) => {
  const names = new Map<string, Named>();
  const held = new Set<string>();
  const shared = new Set<string>();
  const hold = (name: string, named: Named): void => {
    const key = fold(name);
    if (key === "" || held.has(key)) return;
    held.add(key);
    names.set(key, named);
  };
  const add = (name: string, code: CountryCode): void => {
    const key = fold(name);
    if (key === "" || held.has(key) || shared.has(key)) return;
    const named = names.get(key);
    if (named === undefined) names.set(key, { kind: "country", code });
    else if (named.kind !== "country" || named.code !== code) {
      shared.add(key);
      names.delete(key);
    }
  };
  for (const name of organisations) hold(name, { kind: "organisation", name });
  for (const [name, code] of Object.entries(aliases)) hold(name, { kind: "country", code });
  for (const code of countries) {
    for (const name of namesOf(code)) add(name, code);
  }
  const longest = Math.max(1, ...[...names.keys()].map((key) => wordsOf(key).length));
  return { names, longest };
};

// The name is the longest run of leading words the index knows; the rest is the scope.
export const readEntry: ReadEntryFunction = (text, { names, longest }) => {
  const words = wordsOf(text);
  for (let count = Math.min(longest, words.length); count > 0; count -= 1) {
    const named = names.get(fold(words.slice(0, count).join(" ")));
    if (named === undefined) continue;
    const name = words
      .slice(0, count)
      .join(" ")
      .replace(/[,.;:]+$/, "");
    const scope = words.slice(count).join(" ");
    return named.kind === "country"
      ? { kind: "country", code: named.code, name, scope }
      : { kind: "organisation", name: named.name, scope };
  }
  return { kind: "unknown", text };
};
