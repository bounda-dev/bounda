export interface HeldKeysArgs {
  readonly personalKeys: string;
  // The placeholder of the `jsonb` array of persons.
  readonly persons: string;
}

export interface HeldKeysFunction {
  (args: HeldKeysArgs): string;
}

/**
 * A condition true when every person in `persons` holds, in `personalKeys`, the key of the
 * fingerprint named with them, or any key for a `null` one. A person named under two keys never
 * holds both. The keys it finds stay locked until the transaction ends: a forget that removes one
 * waits for the write, and then finds the row to remove.
 */
export const heldKeys: HeldKeysFunction = ({ personalKeys, persons }) =>
  `(SELECT count(*) FROM (SELECT 1 FROM ${personalKeys} AS "k" JOIN jsonb_to_recordset(${persons}::jsonb) AS "p"("person" text, "fingerprint" text) ON "k"."person" = "p"."person" AND "k"."fingerprint" = coalesce("p"."fingerprint", "k"."fingerprint") FOR SHARE OF "k") AS "held") = jsonb_array_length(${persons}::jsonb)`;

export interface NamingFunction {
  (person: string): string;
}

/**
 * A condition true for a row whose `persons` names the person of the placeholder `person`.
 */
export const naming: NamingFunction = (person) =>
  `"persons" @> jsonb_build_array(jsonb_build_object('person', ${person}::text))`;
