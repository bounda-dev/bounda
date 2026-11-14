import { DEFAULT_PERSONAL_CATEGORY } from "../adapter/storage/personal-key-store.ts";
import type { Simplify } from "./naming.ts";
import type { PersonalOptions } from "./personal.ts";

/**
 * Storage types a read-model field can have.
 */
export type FieldType = "string" | "number" | "boolean" | "date" | "json";

/**
 * How a read-model field is marked: `personal` holds personal data of the person the row's
 * `person` field names, `person` is that field.
 */
export type FieldMark = "personal" | "person";

/**
 * What a table can filter a field by: how it is stored, or, for a field marked `.personal()` and
 * so sealed at rest, `sealed`, nothing, and `lookup`, equality through its blind index, which
 * `.index()` or `.unique()` gives it.
 */
export type FieldAccess = FieldType | "sealed" | "lookup";

/**
 * What `.personal()` takes on a read-model field.
 */
export interface PersonalFieldOptions extends PersonalOptions {
  /**
   * Stores the value in the clear instead of sealed under the person's key, so SQL can sort it and
   * filter it by range, at the price sealing spares: forgetting the person then depends on the read
   * model's projection of `PersonalDataForgotten`, which a read model with such a field must have,
   * and a direct read of the table, or a copy of it, shows the value.
   */
  readonly clear?: boolean;
}

/**
 * A read-model field as the runtime and the adapters see it. `Value` is the TypeScript type of
 * the column; it is carried at the type level only. `Type` is how it is stored, which decides
 * what a table can filter it by.
 */
export interface FieldDefinition<
  Value = unknown,
  Optional extends boolean = boolean,
  Mark extends FieldMark | null = FieldMark | null,
  Type extends FieldType = FieldType,
  Indexed extends boolean = boolean,
  Clear extends boolean = boolean,
> {
  readonly type: Type;
  readonly isOptional: Optional;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  /**
   * Adapters store a marked column as any other.
   */
  readonly mark: Mark;
  /**
   * The category of a field marked `personal`, `DEFAULT_PERSONAL_CATEGORY` unless it was given
   * one; `null` for any other field.
   */
  readonly category: string | null;
  /**
   * Whether a field marked `personal` is stored in the clear rather than sealed; `false` for any
   * other field.
   */
  readonly clear: Clear;
  readonly _value?: Value;
  /**
   * Whether `.index()` or `.unique()` was called, at the type level only.
   */
  readonly _indexed?: Indexed;
}

/**
 * A field under construction. Every method returns a new field; nothing is mutated.
 */
export interface Field<
  Value,
  Optional extends boolean,
  Mark extends FieldMark | null = null,
  Type extends FieldType = FieldType,
  Indexed extends boolean = false,
  Clear extends boolean = false,
> extends FieldDefinition<Value, Optional, Mark, Type, Indexed, Clear> {
  optional(): Field<Value, true, Mark, Type, Indexed, Clear>;
  primaryKey(): Field<Value, Optional, Mark, Type, Indexed, Clear>;
  /**
   * On a field sealed at rest, the uniqueness holds on its blind index, which is what `where`
   * matches it by.
   */
  unique(): Field<Value, Optional, Mark, Type, true, Clear>;
  /**
   * On a field sealed at rest, gives it a blind index, so `where` matches it by equality, `ne` or
   * `in`; it still never sorts or filters by range.
   */
  index(): Field<Value, Optional, Mark, Type, true, Clear>;
  /**
   * Marks the field as personal data of the person the row's `person` field names, in the
   * category given, the default one without. The value is sealed at rest under that person's key of
   * the category: the table holds only ciphertext, which the runtime opens for projections and
   * queries, never for a restricted person without a basis named, and which no one opens once the
   * category is forgotten, so the field reads as `null` from then on. A sealed field is never
   * sorted or filtered by range; `.index()` or `.unique()` gives it a blind index for equality.
   * `clear: true` stores it in the clear instead. The export of that person carries it with its
   * category, and a query that reads rows of the read model is recorded in the access log. A read
   * model with personal fields needs a `person` field, and one with a field in the clear a
   * projection of `PersonalDataForgotten`, or `.bounda/types.ts` does not compile; a primary key is
   * never sealed.
   */
  personal<const Options extends PersonalFieldOptions = Record<never, never>>(
    this: Field<Value, Optional, null, Type, Indexed, false>,
    options?: Options,
  ): Field<
    Value,
    Optional,
    "personal",
    Type,
    Indexed,
    Options extends { readonly clear: true } ? true : false
  >;
  /**
   * Marks the field that holds the id of the person the row's personal fields belong to. A read
   * model has at most one; its rows are in that person's export.
   */
  person(
    this: Field<string, Optional, null, Type, Indexed, false>,
  ): Field<Value, Optional, "person", Type, Indexed, false>;
}

/**
 * The `f` object a view's `fields` function receives.
 */
export interface FieldBuilder {
  string(): Field<string, false, null, "string">;
  number(): Field<number, false, null, "number">;
  boolean(): Field<boolean, false, null, "boolean">;
  date(): Field<Date, false, null, "date">;
  json<Value>(): Field<Value, false, null, "json">;
}

/**
 * Arguments of a view's `fields` function.
 */
export interface FieldsArgs {
  readonly f: FieldBuilder;
}

/**
 * What `fields` returns: named field definitions.
 */
export type FieldsRecord = Readonly<Record<string, FieldDefinition>>;

export interface ViewModule {
  readonly fields: (args: FieldsArgs) => FieldsRecord;
  /**
   * `false` states that the read model keeps nothing of a person's data, nor anything derived
   * from it, though it projects events with personal fields: the total of an order but not the
   * address on it. Such a read model marks no field `.personal()` or `.person()`, and a redaction or
   * a forgetting leaves it as it is. A read model that projects events with personal fields needs
   * either this or a field marked `.person()`, or `.bounda/types.ts` does not compile and the app
   * refuses to start; what the statement leaves out is the app's to answer for.
   */
  readonly holdsPersonalData?: false;
}

// A field marked `.personal()` without `clear` is sealed at rest.
type IsSealed<F> = F extends { readonly mark: "personal"; readonly clear: false } ? true : false;

// A sealed field reads as `null` once its category of its person is forgotten.
type FieldValue<F> =
  F extends FieldDefinition<infer Value, boolean>
    ? IsSealed<F> extends true
      ? Value | null
      : Value
    : never;

type RequiredKeys<Fields extends FieldsRecord> = {
  [K in keyof Fields]: Fields[K] extends FieldDefinition<unknown, true> ? never : K;
}[keyof Fields];

type OptionalKeys<Fields extends FieldsRecord> = {
  [K in keyof Fields]: Fields[K] extends FieldDefinition<unknown, true> ? K : never;
}[keyof Fields];

/**
 * The row type of a read model, derived from its field definitions. Optional fields become
 * optional properties, and a field sealed at rest may read as `null`.
 */
export type InferRow<Fields extends FieldsRecord> = Simplify<
  { readonly [K in RequiredKeys<Fields>]: FieldValue<Fields[K]> } & {
    readonly [K in OptionalKeys<Fields>]?: FieldValue<Fields[K]>;
  }
>;

/**
 * The row type of a view module.
 */
export type RowOf<Module> = Module extends {
  readonly fields: (args: FieldsArgs) => infer Fields extends FieldsRecord;
}
  ? InferRow<Fields>
  : never;

type AccessOf<F extends FieldDefinition> =
  IsSealed<F> extends true
    ? F extends { readonly _indexed?: true }
      ? "lookup"
      : "sealed"
    : F["type"];

/**
 * How each field of a view module is stored, or sealed, which decides what its table can filter it
 * by.
 */
export type FieldTypesOf<Module> = Module extends {
  readonly fields: (args: FieldsArgs) => infer Fields extends FieldsRecord;
}
  ? { readonly [K in keyof Fields]: AccessOf<Fields[K]> }
  : never;

interface FieldFlags {
  readonly type: FieldType;
  readonly isOptional: boolean;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  readonly mark: FieldMark | null;
  readonly category: string | null;
  readonly clear: boolean;
}

// The type parameters only exist at the type level; every field is built from its flags.
type AnyField = Field<never, boolean, FieldMark | null, FieldType, boolean, boolean>;

const createField = (flags: FieldFlags): AnyField =>
  ({
    type: flags.type,
    isOptional: flags.isOptional,
    isPrimaryKey: flags.isPrimaryKey,
    isUnique: flags.isUnique,
    isIndexed: flags.isIndexed,
    mark: flags.mark,
    category: flags.category,
    clear: flags.clear,
    optional: () => createField({ ...flags, isOptional: true }),
    primaryKey: () => createField({ ...flags, isPrimaryKey: true }),
    unique: () => createField({ ...flags, isUnique: true }),
    index: () => createField({ ...flags, isIndexed: true }),
    personal: (options?: PersonalFieldOptions) =>
      createField({
        ...flags,
        mark: "personal",
        category: options?.category ?? DEFAULT_PERSONAL_CATEGORY,
        clear: options?.clear === true,
      }),
    person: () => createField({ ...flags, mark: "person" }),
  }) as unknown as AnyField;

const field = <Value, Type extends FieldType>(type: Type): Field<Value, false, null, Type> =>
  createField({
    type,
    isOptional: false,
    isPrimaryKey: false,
    isUnique: false,
    isIndexed: false,
    mark: null,
    category: null,
    clear: false,
  }) as unknown as Field<Value, false, null, Type>;

/**
 * The runtime `f` builder.
 */
export const fieldBuilder: FieldBuilder = {
  string: () => field<string, "string">("string"),
  number: () => field<number, "number">("number"),
  boolean: () => field<boolean, "boolean">("boolean"),
  date: () => field<Date, "date">("date"),
  json: <Value>() => field<Value, "json">("json"),
};
