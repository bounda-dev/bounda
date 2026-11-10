import { z } from "zod";
import { DEFAULT_PERSONAL_CATEGORY } from "../../adapter/storage/personal-key-store.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { personalMarkOf } from "../../modules/personal.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import type { ProcessesRuntime } from "../process/build-processes.ts";

/**
 * What an event's or a command's payload schema, or a process's state schema, marks: the fields to
 * encrypt, the category each is sealed under, and the field naming the person they belong to, or
 * whom the payload touches when it marks no field to encrypt; `null` when the aggregate's or the
 * instance's id names them.
 */
export interface PersonalMarks {
  readonly person: string | null;
  readonly fields: readonly string[];
  readonly categories: Readonly<Record<string, string>>;
}

export interface PersonalMarksOfArgs {
  readonly schema: z.ZodType | null;
  readonly path: string;
}

export interface PersonalMarksOfFunction {
  (args: PersonalMarksOfArgs): PersonalMarks | null;
}

/**
 * `null` for a payload without marks. Only the top-level fields of an object payload are read: a
 * mark deeper down, or on a payload that is not an object, is never found, so a whole object or
 * array is marked as one field.
 */
export const personalMarksOf: PersonalMarksOfFunction = ({ schema, path }) => {
  if (!(schema instanceof z.ZodObject)) return null;
  const fields: string[] = [];
  const categories: Record<string, string> = {};
  const persons: string[] = [];
  for (const [name, field] of Object.entries(schema.shape)) {
    const marked = personalMarkOf(field as z.ZodType);
    if (marked?.mark === "personal") {
      fields.push(name);
      categories[name] = marked.category;
    }
    if (marked?.mark === "person") persons.push(name);
  }
  if (persons.length > 1) {
    throw new ConfigurationError(
      `${path}: marks ${persons.map((name) => `"${name}"`).join(" and ")} with person; a payload names at most one person`,
    );
  }
  if (fields.length === 0 && persons.length === 0) return null;
  return { person: persons[0] ?? null, fields, categories };
};

export interface FieldCategoryFunction {
  (marks: PersonalMarks, field: string): string;
}

export const fieldCategory: FieldCategoryFunction = (marks, field) =>
  marks.categories[field] ?? DEFAULT_PERSONAL_CATEGORY;

export interface MarksPersonalFieldsArgs {
  readonly aggregates: AggregatesRuntime;
  readonly processes: ProcessesRuntime;
}

export interface MarksPersonalFieldsFunction {
  (args: MarksPersonalFieldsArgs): boolean;
}

/**
 * Whether any event, command or process state of the registry marks a field `personal`, which
 * then needs keys.
 */
export const marksPersonalFields: MarksPersonalFieldsFunction = ({ aggregates, processes }) =>
  processes.all.some((process) => (process.personal?.fields.length ?? 0) > 0) ||
  Object.values(aggregates.byName).some(
    (aggregate) =>
      Object.values(aggregate.eventsByType).some(
        (event) => (event.personal?.fields.length ?? 0) > 0,
      ) ||
      Object.values(aggregate.commands).some(
        (command) => (command.personal?.fields.length ?? 0) > 0,
      ),
  );
