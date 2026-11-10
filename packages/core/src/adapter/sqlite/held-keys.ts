import type { PersonIndexedStore } from "./schema.ts";

export interface HeldKeysFunction {
  (personalKeys: string): string;
}

/**
 * A condition true when every person in the JSON array of the first parameter named with a
 * fingerprint holds, in `personalKeys`, the key of that fingerprint in force; the second parameter
 * is the same array. A person named with `null` was read in the clear and needs no key. Each entry
 * names one key, which a person holds at most once.
 */
export const heldKeys: HeldKeysFunction = (personalKeys) =>
  `(SELECT count(*) FROM ${personalKeys} AS "k" JOIN json_each(?) AS "p" ON "k"."person" = json_extract("p"."value", '$.person') AND "k"."fingerprint" = json_extract("p"."value", '$.fingerprint') WHERE "k"."retained_since" IS NULL) = (SELECT count(*) FROM json_each(?) WHERE json_extract("value", '$.fingerprint') IS NOT NULL)`;

export interface OutsideKeptFunction {
  (row: string): string;
}

/**
 * A condition true for a row of the table `row` whose `persons` names the person of the first
 * parameter under a key outside the JSON array of fingerprints of the second, or read in the
 * clear.
 */
export const outsideKept: OutsideKeptFunction = (row) =>
  `EXISTS (SELECT 1 FROM json_each(${row}."persons") AS "n" WHERE json_extract("n"."value", '$.person') = ? AND (json_extract("n"."value", '$.fingerprint') IS NULL OR json_extract("n"."value", '$.fingerprint') NOT IN (SELECT "value" FROM json_each(?))))`;

export interface NamingArgs {
  readonly personRows: string;
  readonly indexed: PersonIndexedStore;
}

export interface NamingFunction {
  (args: NamingArgs): string;
}

/**
 * A condition true for a row whose `persons` names the person of the parameter, which the index
 * of `personRows` answers without reading the store's table.
 */
export const naming: NamingFunction = ({ personRows, indexed }) =>
  `(${indexed.key.map((column) => `"${column}"`).join(", ")}) IN (SELECT ${indexed.key.map((_, at) => `json_extract("row", '$[${at}]')`).join(", ")} FROM ${personRows} WHERE "person" = ? AND "store" = '${indexed.store}')`;
