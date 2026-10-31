import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { personalMarkOf } from "../../modules/personal.ts";

/**
 * What an event's payload schema marks: the fields to encrypt and the field naming the person
 * they belong to, `null` when the aggregate's id names them.
 */
export interface PersonalMarks {
  readonly person: string | null;
  readonly fields: readonly string[];
}

export interface PersonalMarksOfArgs {
  readonly schema: z.ZodType | null;
  readonly path: string;
}

export interface PersonalMarksOfFunction {
  (args: PersonalMarksOfArgs): PersonalMarks | null;
}

/**
 * `null` for an event without personal fields. Only the top-level fields of an object payload
 * are read: a mark deeper down, or on a payload that is not an object, is never found, so a
 * whole object or array is marked as one field.
 */
export const personalMarksOf: PersonalMarksOfFunction = ({ schema, path }) => {
  if (!(schema instanceof z.ZodObject)) return null;
  const fields: string[] = [];
  const persons: string[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const mark = personalMarkOf(field as z.ZodType);
    if (mark === "personal") fields.push(name);
    if (mark === "person") persons.push(name);
  }
  if (persons.length > 1) {
    throw new ConfigurationError(
      `${path}: marks ${persons.map((name) => `"${name}"`).join(" and ")} with person; an event names at most one person`,
    );
  }
  if (fields.length === 0) return null;
  return { person: persons[0] ?? null, fields };
};
