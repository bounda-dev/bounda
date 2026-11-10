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
 * A read-model field as the runtime and the adapters see it. `Value` is the TypeScript type of
 * the column; it is carried at the type level only. `Type` is how it is stored, which decides
 * what a table can filter it by.
 */
export interface FieldDefinition<
  Value = unknown,
  Optional extends boolean = boolean,
  Mark extends FieldMark | null = FieldMark | null,
  Type extends FieldType = FieldType,
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
  readonly _value?: Value;
}

/**
 * A field under construction. Every method returns a new field; nothing is mutated.
 */
export interface Field<
  Value,
  Optional extends boolean,
  Mark extends FieldMark | null = null,
  Type extends FieldType = FieldType,
> extends FieldDefinition<Value, Optional, Mark, Type> {
  optional(): Field<Value, true, Mark, Type>;
  primaryKey(): Field<Value, Optional, Mark, Type>;
  unique(): Field<Value, Optional, Mark, Type>;
  index(): Field<Value, Optional, Mark, Type>;
  /**
   * Marks the field as personal data of the person the row's `person` field names, in the
   * category given, the default one without: the export of that person carries it with its
   * category, and a query that reads rows of the read model is recorded in the access log. A read
   * model with personal fields needs a `person` field and a projection of `PersonalDataForgotten`,
   * or `.bounda/types.ts` does not compile.
   */
  personal(
    this: Field<Value, Optional, null, Type>,
    options?: PersonalOptions,
  ): Field<Value, Optional, "personal", Type>;
  /**
   * Marks the field that holds the id of the person the row's personal fields belong to. A read
   * model has at most one; its rows are in that person's export.
   */
  person(this: Field<string, Optional, null, Type>): Field<Value, Optional, "person", Type>;
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
}

type FieldValue<F> = F extends FieldDefinition<infer Value, boolean> ? Value : never;

type RequiredKeys<Fields extends FieldsRecord> = {
  [K in keyof Fields]: Fields[K] extends FieldDefinition<unknown, true> ? never : K;
}[keyof Fields];

type OptionalKeys<Fields extends FieldsRecord> = {
  [K in keyof Fields]: Fields[K] extends FieldDefinition<unknown, true> ? K : never;
}[keyof Fields];

/**
 * The row type of a read model, derived from its field definitions. Optional fields become
 * optional properties.
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

/**
 * How each field of a view module is stored, which decides what its table can filter it by.
 */
export type FieldTypesOf<Module> = Module extends {
  readonly fields: (args: FieldsArgs) => infer Fields extends FieldsRecord;
}
  ? { readonly [K in keyof Fields]: Fields[K]["type"] }
  : never;

interface FieldFlags {
  readonly type: FieldType;
  readonly isOptional: boolean;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  readonly mark: FieldMark | null;
  readonly category: string | null;
}

const createField = <
  Value,
  Optional extends boolean,
  Mark extends FieldMark | null,
  Type extends FieldType,
>(
  flags: FieldFlags,
): Field<Value, Optional, Mark, Type> => ({
  type: flags.type as Type,
  isOptional: flags.isOptional as Optional,
  isPrimaryKey: flags.isPrimaryKey,
  isUnique: flags.isUnique,
  isIndexed: flags.isIndexed,
  mark: flags.mark as Mark,
  category: flags.category,
  optional: () => createField<Value, true, Mark, Type>({ ...flags, isOptional: true }),
  primaryKey: () => createField<Value, Optional, Mark, Type>({ ...flags, isPrimaryKey: true }),
  unique: () => createField<Value, Optional, Mark, Type>({ ...flags, isUnique: true }),
  index: () => createField<Value, Optional, Mark, Type>({ ...flags, isIndexed: true }),
  personal: (options?: PersonalOptions) =>
    createField<Value, Optional, "personal", Type>({
      ...flags,
      mark: "personal",
      category: options?.category ?? DEFAULT_PERSONAL_CATEGORY,
    }),
  person: () => createField<Value, Optional, "person", Type>({ ...flags, mark: "person" }),
});

const field = <Value, Type extends FieldType>(type: Type): Field<Value, false, null, Type> =>
  createField<Value, false, null, Type>({
    type,
    isOptional: false,
    isPrimaryKey: false,
    isUnique: false,
    isIndexed: false,
    mark: null,
    category: null,
  });

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
