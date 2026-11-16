import { z } from "zod";
import { ConfigurationError } from "../../contracts/errors.ts";
import { capitalize } from "../../modules/naming.ts";
import { type PersonalMark, personalMarkOf } from "../../modules/personal.ts";
import type { Registry } from "../../modules/registry.ts";
import { type FieldMark, type FieldsRecord, fieldBuilder } from "../../modules/view.ts";
import { schemaArgs } from "../aggregate/build-aggregates.ts";
import { isInstantField, processStateArgs } from "../process/deadlines.ts";

// `instant` for a moment of a process state, which needs no mark.
export type FieldClassification = PersonalMark | { readonly mark: "instant" } | null;

export interface ClassifiedField {
  readonly name: string;
  readonly classification: FieldClassification;
  readonly holdsText: boolean;
}

export interface SchemaClassification {
  readonly fields: readonly ClassifiedField[];
  // Text no mark reaches: a payload that is not an object, or keys an object does not declare.
  readonly unmarkableText: boolean;
}

type Def = Readonly<Record<string, unknown>> & { readonly type: string };

const defOf = (schema: z.ZodType): Def => schema._zod.def as unknown as Def;

const asSchema = (value: unknown): z.ZodType | undefined =>
  value instanceof z.ZodType ? value : undefined;

const TEXT_TYPES = new Set(["string", "template_literal", "any", "unknown"]);

// Wrappers whose input and output are those of the schema they wrap.
const WRAPPED = ["innerType", "in", "out", "left", "right", "keyType", "valueType", "element"];

export interface HoldsTextFunction {
  (schema: z.ZodType, seen?: Set<z.ZodType>): boolean;
}

// Read from the structure. What a `.transform()` gives cannot be read, so it counts as no text;
// `.bounda/types.ts` reads it from the types, which see it, so whatever this finds they find too.
export const holdsText: HoldsTextFunction = (schema, seen = new Set()) => {
  if (seen.has(schema) || isInstantField(schema)) return false;
  seen.add(schema);
  const def = defOf(schema);
  if (TEXT_TYPES.has(def.type)) return true;
  const inner = (value: unknown): boolean => {
    const child = asSchema(value);
    return child !== undefined && holdsText(child, seen);
  };
  switch (def.type) {
    case "object":
      return (
        Object.values(def.shape as Readonly<Record<string, unknown>>).some(inner) ||
        inner(def.catchall)
      );
    case "tuple":
      return (def.items as readonly unknown[]).some(inner) || inner(def.rest);
    case "union":
      return (def.options as readonly unknown[]).some(inner);
    case "lazy":
      return inner((def.getter as () => unknown)());
    default:
      return WRAPPED.some((key) => inner(def[key]));
  }
};

const classificationOf = (schema: z.ZodType): FieldClassification => {
  const mark = personalMarkOf(schema);
  if (mark !== null) return mark;
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    if (isInstantField(current)) return { mark: "instant" };
    const def = defOf(current);
    current = asSchema(def.innerType) ?? asSchema(def.in);
  }
  return null;
};

export interface ClassifySchemaFunction {
  (schema: z.ZodType): SchemaClassification;
}

// Top-level fields, the unit marks work on: a whole object or array is one field.
export const classifySchema: ClassifySchemaFunction = (schema) => {
  if (!(schema instanceof z.ZodObject)) {
    return { fields: [], unmarkableText: holdsText(schema) };
  }
  // Keys an object does not declare are text of their own, as a record's are, whatever they hold.
  const catchall = asSchema(schema._zod.def.catchall);
  return {
    fields: Object.entries(schema.shape).map(([name, field]) => ({
      name,
      classification: classificationOf(field as z.ZodType),
      holdsText: holdsText(field as z.ZodType),
    })),
    unmarkableText: catchall !== undefined && defOf(catchall).type !== "never",
  };
};

export interface ClassifiedViewField {
  readonly name: string;
  readonly mark: FieldMark | null;
  // A `string` column holds any text it is given, whatever its projections write.
  readonly holdsText: boolean;
}

export interface ClassifyViewFunction {
  (fields: FieldsRecord): readonly ClassifiedViewField[];
}

export const classifyView: ClassifyViewFunction = (fields) =>
  Object.entries(fields).map(([name, field]) => ({
    name,
    mark: field.mark,
    holdsText: field.type === "string",
  }));

export interface SchemaOfFunction {
  (build: unknown, args: object): z.ZodType | null;
}

// A module's `payload` or `state`, built as the runtime builds it; `null` without one.
export const schemaOf: SchemaOfFunction = (build, args) =>
  typeof build === "function" ? (build(args) as z.ZodType) : null;

// The same messages as `.bounda/types.ts`, whose check finds all this finds.
const schemaProblems = (name: string, schema: z.ZodType | null): string[] => {
  if (schema === null) return [];
  const classified = classifySchema(schema);
  const fields = classified.fields
    .filter((field) => field.classification === null && field.holdsText)
    .map(
      (field) =>
        `${name}: field ${field.name} can hold text; mark it personal(), person() or notPersonal()`,
    );
  if (!classified.unmarkableText) return fields;
  return [
    schema instanceof z.ZodObject
      ? `${name} keeps keys it does not declare, which no mark reaches; use z.object or z.strictObject`
      : `${name} is not an object, so no mark reaches the text it holds; make it z.object({ ... })`,
    ...fields,
  ];
};

export interface CheckClassificationFunction {
  (registry: Registry): void;
}

export const checkClassification: CheckClassificationFunction = (registry) => {
  const problems: string[] = [];
  for (const [aggregate, entry] of Object.entries(registry.aggregates)) {
    for (const [key, module] of Object.entries(entry.events)) {
      problems.push(
        ...schemaProblems(`${aggregate}.${capitalize(key)}`, schemaOf(module.payload, schemaArgs)),
      );
    }
    for (const [key, command] of Object.entries(entry.commands)) {
      problems.push(
        ...schemaProblems(`${aggregate}.${key}`, schemaOf(command.module.payload, schemaArgs)),
      );
    }
    for (const [key, process] of Object.entries(entry.processes)) {
      problems.push(
        ...schemaProblems(`${aggregate}.${key}`, schemaOf(process.module.state, processStateArgs)),
      );
    }
  }
  for (const [name, entry] of Object.entries(registry.readModels)) {
    for (const column of classifyView(entry.view.fields({ f: fieldBuilder }))) {
      if (column.mark === null && column.holdsText) {
        problems.push(
          `Read model ${name}: column ${column.name} can hold text; mark it .personal(), .person() or .notPersonal()`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new ConfigurationError(
      `Every field that can hold text is marked personal, person or notPersonal:\n  ${problems.join("\n  ")}`,
    );
  }
};
