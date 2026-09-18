import type { Simplify } from "./naming.ts";

/**
 * Storage types a read-model field can have.
 */
export type FieldType = "string" | "number" | "boolean" | "date" | "json";

/**
 * A read-model field as the runtime and the adapters see it. `Value` is the TypeScript type of
 * the column; it is carried at the type level only.
 */
export interface FieldDefinition<Value = unknown, Optional extends boolean = boolean> {
  readonly type: FieldType;
  readonly isOptional: Optional;
  readonly isPrimaryKey: boolean;
  readonly isUnique: boolean;
  readonly isIndexed: boolean;
  readonly _value?: Value;
}

/**
 * A field under construction. Every method returns a new field; nothing is mutated.
 */
export interface Field<Value, Optional extends boolean> extends FieldDefinition<Value, Optional> {
  optional(): Field<Value, true>;
  primaryKey(): Field<Value, Optional>;
  unique(): Field<Value, Optional>;
  index(): Field<Value, Optional>;
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

/**
 * The shape of a `view.ts` module.
 */
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
}

const createField = <Value, Optional extends boolean>(
  flags: FieldFlags,
): Field<Value, Optional> => ({
  type: flags.type,
  isOptional: flags.isOptional as Optional,
  isPrimaryKey: flags.isPrimaryKey,
  isUnique: flags.isUnique,
  isIndexed: flags.isIndexed,
  optional: () => createField<Value, true>({ ...flags, isOptional: true }),
  primaryKey: () => createField<Value, Optional>({ ...flags, isPrimaryKey: true }),
  unique: () => createField<Value, Optional>({ ...flags, isUnique: true }),
  index: () => createField<Value, Optional>({ ...flags, isIndexed: true }),
});

const field = <Value>(type: FieldType): Field<Value, false> =>
  createField<Value, false>({
    type,
    isOptional: false,
    isPrimaryKey: false,
    isUnique: false,
    isIndexed: false,
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
