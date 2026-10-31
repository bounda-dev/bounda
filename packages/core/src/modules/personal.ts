import type { z } from "zod";

declare const personalBrand: unique symbol;
declare const personBrand: unique symbol;

/**
 * The schema `personal(schema)` returns: what `schema` takes when the event is written, and what
 * it gives or `null` when read, since the field reads as `null` once its person is forgotten.
 */
export interface PersonalSchema<Schema extends z.ZodType>
  extends z.ZodPipe<Schema, z.ZodTransform<z.output<Schema> | null, z.output<Schema>>> {
  readonly [personalBrand]: true;
}

/**
 * The schema `person(schema)` returns: `schema`, marked as the field that identifies the person
 * the event's personal fields belong to.
 */
export interface PersonSchema<Schema extends z.ZodType>
  extends z.ZodPipe<Schema, z.ZodTransform<z.output<Schema>, z.output<Schema>>> {
  readonly [personBrand]: true;
}

/**
 * Marks a field of an event's payload as personal data: it is stored encrypted with the key of
 * the person the event names, and reads as `null` once that person is forgotten. Any schema
 * works, an object or an array included, at the top level of the payload. A command or a query
 * payload cannot use it.
 */
export interface PersonalFunction {
  <Schema extends z.ZodType>(schema: Schema): PersonalSchema<Schema>;
}

/**
 * Marks the field of an event's payload that identifies the person its personal fields belong
 * to, such as the customer's id in an order's event. Without it, the aggregate's id is the
 * person. An event has at most one.
 */
export interface PersonFunction {
  <Schema extends z.ZodType>(schema: Schema): PersonSchema<Schema>;
}

const PERSONAL = new WeakSet<z.ZodType>();
const PERSON = new WeakSet<z.ZodType>();

export const personal: PersonalFunction = <Schema extends z.ZodType>(schema: Schema) => {
  const marked = schema.transform((value): z.output<Schema> | null => value);
  PERSONAL.add(marked);
  return marked as PersonalSchema<Schema>;
};

export const person: PersonFunction = <Schema extends z.ZodType>(schema: Schema) => {
  const marked = schema.transform((value): z.output<Schema> => value);
  PERSON.add(marked);
  return marked as PersonSchema<Schema>;
};

export type PersonalMark = "personal" | "person";

export interface PersonalMarkOfFunction {
  (schema: z.ZodType): PersonalMark | null;
}

interface Wrapper {
  readonly innerType?: z.ZodType;
  readonly in?: z.ZodType;
}

// A mark sits on the schema `personal` or `person` returned, however it was wrapped afterwards:
// `.optional()`, `.nullable()`, `.default()` and the like keep what they wrap in `innerType`,
// and a `.transform()` or `.pipe()` in `in`.
export const personalMarkOf: PersonalMarkOfFunction = (schema) => {
  let current: z.ZodType | undefined = schema;
  while (current !== undefined) {
    if (PERSONAL.has(current)) return "personal";
    if (PERSON.has(current)) return "person";
    const def = current._zod.def as Wrapper;
    current = def.innerType ?? def.in;
  }
  return null;
};

type Unwrapped<Schema> = Schema extends {
  readonly _zod: { readonly def: { readonly innerType: infer Inner } };
}
  ? Inner
  : Schema extends { readonly _zod: { readonly def: { readonly in: infer Inner } } }
    ? Inner
    : never;

type IsPersonal<Schema> = Schema extends { readonly [personalBrand]: true }
  ? true
  : IsPersonalInside<Unwrapped<Schema>>;

// Apart so a schema without `innerType` ends the recursion instead of instantiating it on `never`.
type IsPersonalInside<Inner> = [Inner] extends [never] ? false : IsPersonal<Inner>;

type SchemaOf<Module> = Module extends { readonly payload: (args: never) => infer Schema }
  ? Schema
  : never;

/**
 * Whether an event module marks any top-level field of its payload with `personal`. Distributes
 * over a union of modules.
 */
export type HasPersonalFields<Module> = Module extends unknown
  ? SchemaOf<Module> extends z.ZodObject<infer Shape>
    ? true extends { [Key in keyof Shape]: IsPersonal<Shape[Key]> }[keyof Shape]
      ? true
      : false
    : false
  : never;

/**
 * `true` when the read model `Name` may project `Modules`: when it projects
 * `PersonalDataForgotten` (`Handles`), or when none of them has a personal field. Otherwise a
 * message saying what to add, which the generator's `.bounda/types.ts` fails to compile on.
 */
export type ForgetsPersonalData<
  Name extends string,
  Modules,
  Handles extends boolean,
> = Handles extends true
  ? true
  : true extends HasPersonalFields<Modules>
    ? `Read model ${Name} projects personal data, so it needs projections/bounda/personal-data-forgotten.ts`
    : true;
