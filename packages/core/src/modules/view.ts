import type { Simplify } from "./naming.ts";

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
 * the column; it is carried at the type level only.
 */
export interface FieldDefinition<
  Value = unknown,
  Optional extends boolean = boolean,
  Mark extends FieldMark | null = FieldMark | null,
> {
  readonly type: FieldType;
  readonly isOptional: Optional;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  /**
   * Adapters store a marked column as any other.
   */
  readonly mark: Mark;
  readonly _value?: Value;
}

/**
 * A field under construction. Every method returns a new field; nothing is mutated.
 */
export interface Field<Value, Optional extends boolean, Mark extends FieldMark | null = null>
  extends FieldDefinition<Value, Optional, Mark> {
  optional(): Field<Value, true, Mark>;
  primaryKey(): Field<Value, Optional, Mark>;
  unique(): Field<Value, Optional, Mark>;
  index(): Field<Value, Optional, Mark>;
  /**
   * Marks the field as personal data of the person the row's `person` field names: the export of
   * that person carries it, and a query that reads rows of the read model is recorded in the
   * access log. A read model with personal fields needs a `person` field and a projection of
   * `PersonalDataForgotten`, or `.bounda/types.ts` does not compile.
   */
  personal(this: Field<Value, Optional, null>): Field<Value, Optional, "personal">;
  /**
   * Marks the field that holds the id of the person the row's personal fields belong to. A read
   * model has at most one; its rows are in that person's export.
   */
  person(this: Field<string, Optional, null>): Field<Value, Optional, "person">;
}

/**
 * The `f` object a view's `fields` function receives.
 */
export interface FieldBuilder {
  string(): Field<string, false>;
  number(): Field<number, false>;
  boolean(): Field<boolean, false>;
  date(): Field<Date, false>;
  json<Value>(): Field<Value, false>;
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

interface FieldFlags {
  readonly type: FieldType;
  readonly isOptional: boolean;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  readonly mark: FieldMark | null;
}

const createField = <Value, Optional extends boolean, Mark extends FieldMark | null>(
  flags: FieldFlags,
): Field<Value, Optional, Mark> => ({
  type: flags.type,
  isOptional: flags.isOptional as Optional,
  isPrimaryKey: flags.isPrimaryKey,
  isUnique: flags.isUnique,
  isIndexed: flags.isIndexed,
  mark: flags.mark as Mark,
  optional: () => createField<Value, true, Mark>({ ...flags, isOptional: true }),
  primaryKey: () => createField<Value, Optional, Mark>({ ...flags, isPrimaryKey: true }),
  unique: () => createField<Value, Optional, Mark>({ ...flags, isUnique: true }),
  index: () => createField<Value, Optional, Mark>({ ...flags, isIndexed: true }),
  personal: () => createField<Value, Optional, "personal">({ ...flags, mark: "personal" }),
  person: () => createField<Value, Optional, "person">({ ...flags, mark: "person" }),
});

const field = <Value>(type: FieldType): Field<Value, false> =>
  createField<Value, false, null>({
    type,
    isOptional: false,
    isPrimaryKey: false,
    isUnique: false,
    isIndexed: false,
    mark: null,
  });

/**
 * The runtime `f` builder.
 */
export const fieldBuilder: FieldBuilder = {
  string: () => field<string>("string"),
  number: () => field<number>("number"),
  boolean: () => field<boolean>("boolean"),
  date: () => field<Date>("date"),
  json: <Value>() => field<Value>("json"),
};
