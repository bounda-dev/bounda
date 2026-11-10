export interface HeldKeysArgs {
  readonly personalKeys: string;
  // The placeholder of the `jsonb` array of persons.
  readonly persons: string;
}

export interface HeldKeysFunction {
  (args: HeldKeysArgs): string;
}

/**
 * A condition true when every person in `persons` named with a fingerprint holds, in
 * `personalKeys`, the key of that fingerprint in force. A person named with `null` was read in the
 * clear and needs no key. Each entry names one key, which a person holds at most once. The keys it
 * finds stay locked until the transaction ends: a forget that removes or retains one waits for the
 * write, and then finds the row.
 */
export const heldKeys: HeldKeysFunction = ({ personalKeys, persons }) =>
  `(SELECT count(*) FROM (SELECT 1 FROM ${personalKeys} AS "k" JOIN jsonb_to_recordset(${persons}::jsonb) AS "p"("person" text, "fingerprint" text) ON "k"."person" = "p"."person" AND "k"."fingerprint" = "p"."fingerprint" WHERE "k"."retained_since" IS NULL FOR SHARE OF "k") AS "held") = (SELECT count(*) FROM jsonb_to_recordset(${persons}::jsonb) AS "p"("person" text, "fingerprint" text) WHERE "p"."fingerprint" IS NOT NULL)`;

export interface OutsideKeptArgs {
  // The placeholders of the person and of the JSON array of fingerprints kept.
  readonly person: string;
  readonly keep: string;
}

export interface OutsideKeptFunction {
  (args: OutsideKeptArgs): string;
}

/**
 * A condition true for a row whose `persons` names `person` under a key outside `keep`, or read in
 * the clear.
 */
export const outsideKept: OutsideKeptFunction = ({ person, keep }) =>
  `EXISTS (SELECT 1 FROM jsonb_array_elements("persons") AS "n" WHERE "n"->>'person' = ${person}::text AND ("n"->>'fingerprint' IS NULL OR "n"->>'fingerprint' NOT IN (SELECT jsonb_array_elements_text(${keep}::jsonb))))`;

export interface NamingFunction {
  (person: string): string;
}

/**
 * A condition true for a row whose `persons` names the person of the placeholder `person`.
 */
export const naming: NamingFunction = (person) =>
  `"persons" @> jsonb_build_array(jsonb_build_object('person', ${person}::text))`;
