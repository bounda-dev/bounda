import { capitalize, toCamelCase } from "@bounda-dev/core";

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface IsKebabCaseFunction {
  (name: string): boolean;
}

/**
 * The only shape a module or directory name may have: `order-placed`, `on-timeout`, `v2-report`.
 */
export const isKebabCase: IsKebabCaseFunction = (name) => KEBAB_CASE.test(name);

export interface KeyOfFunction {
  (fileName: string): string;
}

export const keyOf: KeyOfFunction = (fileName) => toCamelCase(fileName);

export interface TypeNameOfFunction {
  (key: string): string;
}

export const typeNameOf: TypeNameOfFunction = (key) => capitalize(key);

export interface JoinKeysFunction {
  (...parts: readonly string[]): string;
}

export const joinKeys: JoinKeysFunction = (...parts) =>
  parts.map((part, index) => (index === 0 ? part : capitalize(part))).join("");

const PROCESS_HANDLER = /^on-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface ProcessHandlerEventOfFunction {
  (fileName: string): string | null;
}

export const processHandlerEventOf: ProcessHandlerEventOfFunction = (fileName) => {
  const match = PROCESS_HANDLER.exec(fileName);
  return match?.[1] === undefined ? null : toCamelCase(match[1]);
};

const PROCESS_DEADLINE = /^at-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface ProcessDeadlineOfFunction {
  (fileName: string): string | null;
}

export const processDeadlineOf: ProcessDeadlineOfFunction = (fileName) => {
  const match = PROCESS_DEADLINE.exec(fileName);
  return match?.[1] === undefined ? null : toCamelCase(match[1]);
};

export interface CompareNamesFunction {
  (a: string, b: string): number;
}

/**
 * Orders by UTF-16 code unit, the same on every machine: `localeCompare` follows the machine's
 * locale, which would reorder the generated files from one developer to the next.
 */
export const compareNames: CompareNamesFunction = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export interface UniqueAliasesArgs {
  readonly entries: readonly { readonly alias: string; readonly owner: string }[];
}

export interface UniqueAliasesFunction {
  (args: UniqueAliasesArgs): readonly string[];
}

// Names an alias cannot take: the words an ES module cannot bind (reserved, strict-mode, `eval`
// and `arguments`), and `registry`, which the registry module exports.
const RESERVED = new Set(
  [
    "await break case catch class const continue debugger default delete do else enum export",
    "extends false finally for function if implements import in instanceof interface let new",
    "null package private protected public return static super switch this throw true try",
    "typeof var void while with yield eval arguments registry",
  ]
    .join(" ")
    .split(" "),
);

const countsOf = (names: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

/**
 * An alias two entries share is prefixed with the owner in every one of them, not only the
 * second: `created` in two aggregates gives `orderCreated` and `customerCreated`. So is one that
 * is a reserved word or `registry`: `delete` gives `orderDelete`. A name that still repeats, two entries of one
 * owner, or one that meets an alias left as it was, takes a number: `orderCheckout2`.
 */
export const uniqueAliases: UniqueAliasesFunction = ({ entries }) => {
  const counts = countsOf(entries.map(({ alias }) => alias));
  const wanted = entries.map(({ alias, owner }) =>
    (counts.get(alias) ?? 0) > 1 || RESERVED.has(alias) ? joinKeys(owner, alias) : alias,
  );
  const taken = new Set(wanted);
  const given = new Set<string>();
  return wanted.map((name) => {
    if (!given.has(name)) {
      given.add(name);
      return name;
    }
    let suffix = 2;
    while (taken.has(`${name}${suffix}`)) suffix += 1;
    const numbered = `${name}${suffix}`;
    taken.add(numbered);
    given.add(numbered);
    return numbered;
  });
};
