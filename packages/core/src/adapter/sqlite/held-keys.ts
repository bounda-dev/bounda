export interface HeldKeysFunction {
  (personalKeys: string): string;
}

/**
 * A condition true when every person in the JSON array of the first parameter holds, in
 * `personalKeys`, the key of the fingerprint named with them, or any key for a `null` one; the
 * second parameter is the array's length. A person named under two keys never holds both.
 */
export const heldKeys: HeldKeysFunction = (personalKeys) =>
  `(SELECT count(*) FROM ${personalKeys} AS "k" JOIN json_each(?) AS "p" ON "k"."person" = json_extract("p"."value", '$.person') AND "k"."fingerprint" = coalesce(json_extract("p"."value", '$.fingerprint'), "k"."fingerprint")) = ?`;

export interface NamingFunction {
  (table: string): string;
}

/**
 * A condition true for a row of `table` whose `persons` names the person of the parameter.
 */
export const naming: NamingFunction = (table) =>
  `EXISTS (SELECT 1 FROM json_each(${table}."persons") WHERE json_extract("value", '$.person') = ?)`;
