import { ConfigurationError } from "../../contracts/errors.ts";
import type { FieldDefinition, FieldsRecord } from "../../modules/view.ts";

/**
 * After a personal field's name, the hidden field that holds the fingerprint of the key its value
 * was written under: what tells a value kept under a legal obligation, or forgotten, from one
 * written after.
 */
export const KEY_FIELD_SUFFIX = "__key";

/**
 * After a sealed field's name, the hidden field that holds its blind index, for a field with
 * `.index()` or `.unique()`.
 */
export const INDEX_FIELD_SUFFIX = "__index";

/**
 * Before a fingerprint in a key field, once a forgetting kept the key under a legal obligation:
 * the row is restricted from then on, until the key's retention ends.
 */
export const RETAINED_KEY_PREFIX = "retained:";

/**
 * What a key field holds once a forgetting destroyed the key its value was written under: the value
 * is no one's to read any more, and no later forgetting or retention has anything to do with it.
 */
export const FORGOTTEN_KEY = "forgotten";

/**
 * How every value of a sealed field starts as stored: the JSON of a `$personal` envelope.
 */
export const ENVELOPE_PREFIX = '{"$personal":';

export interface IsSealedFieldFunction {
  (definition: FieldDefinition): boolean;
}

/**
 * Whether a field is marked `.personal()` without `clear`: stored sealed.
 */
export const isSealedField: IsSealedFieldFunction = (definition) =>
  definition.mark === "personal" && definition.clear !== true;

export interface HiddenFieldFunction {
  (field: string): string;
}

export const keyFieldOf: HiddenFieldFunction = (field) => `${field}${KEY_FIELD_SUFFIX}`;

export const indexFieldOf: HiddenFieldFunction = (field) => `${field}${INDEX_FIELD_SUFFIX}`;

export interface IsHiddenFieldFunction {
  (name: string): boolean;
}

/**
 * Whether a field, or the column named after it, is one of those the runtime keeps beside the
 * personal fields: what an inspection treats as opaque.
 */
export const isHiddenField: IsHiddenFieldFunction = (name) =>
  name.endsWith(KEY_FIELD_SUFFIX) || name.endsWith(INDEX_FIELD_SUFFIX);

/**
 * One field marked `.personal()` as the runtime stores it: the hidden field of its key, and of its
 * blind index for a sealed field that has one.
 */
export interface StoredPersonalField {
  readonly field: string;
  readonly category: string;
  readonly sealed: boolean;
  readonly keyField: string;
  readonly indexField: string | null;
  readonly definition: FieldDefinition;
}

export interface StoredPersonalFieldsFunction {
  (fields: FieldsRecord): readonly StoredPersonalField[];
}

/**
 * The personal fields of a view, in declaration order.
 */
export const storedPersonalFields: StoredPersonalFieldsFunction = (fields) =>
  Object.entries(fields).flatMap(([field, definition]) => {
    if (definition.mark !== "personal") return [];
    const sealed = isSealedField(definition);
    return [
      {
        field,
        category: definition.category ?? "",
        sealed,
        keyField: keyFieldOf(field),
        indexField:
          sealed && (definition.isIndexed || definition.isUnique) ? indexFieldOf(field) : null,
        definition,
      },
    ];
  });

const HIDDEN: FieldDefinition = {
  type: "string",
  isOptional: true,
  isPrimaryKey: false,
  isUnique: false,
  isIndexed: false,
  mark: null,
  category: null,
  clear: false,
};

export interface StoredFieldsArgs {
  readonly readModel: string;
  readonly fields: FieldsRecord;
}

export interface StoredFieldsFunction {
  (args: StoredFieldsArgs): FieldsRecord;
}

/**
 * The fields an adapter stores for a view: a sealed field as a string holding its envelope, whose
 * uniqueness and index move to its blind index, and the hidden fields after each personal one.
 * Throws `ConfigurationError` for a sealed primary key, which could never be looked up, and for a
 * field whose name a hidden field takes.
 */
export const storedFields: StoredFieldsFunction = ({ readModel, fields }) => {
  const stored: Record<string, FieldDefinition> = {};
  for (const [field, definition] of Object.entries(fields)) {
    if (isHiddenField(field)) {
      throw new ConfigurationError(
        `Read model "${readModel}": field "${field}" ends with "${KEY_FIELD_SUFFIX}" or "${INDEX_FIELD_SUFFIX}", which the runtime keeps beside personal fields; rename it`,
      );
    }
    if (!isSealedField(definition)) {
      stored[field] = definition;
      continue;
    }
    if (definition.isPrimaryKey) {
      throw new ConfigurationError(
        `Read model "${readModel}": primary key field "${field}" is marked .personal(), and a sealed value is never a key; key the rows by another field, or keep this one in the clear with .personal({ clear: true })`,
      );
    }
    stored[field] = { ...definition, type: "string", isUnique: false, isIndexed: false };
  }
  for (const personal of storedPersonalFields(fields)) {
    stored[personal.keyField] = HIDDEN;
    if (personal.indexField !== null) {
      stored[personal.indexField] = {
        ...HIDDEN,
        isUnique: personal.definition.isUnique,
        isIndexed: personal.definition.isIndexed && !personal.definition.isUnique,
      };
    }
  }
  return stored;
};

/**
 * What `ReadModelTransaction.unsettled` looks for: values a write that went around the runtime
 * left, in a sealed field without an envelope, or in a personal field without its key field.
 */
export interface UnsettledRowsArgs {
  readonly sealed: readonly string[];
  readonly keyed: readonly { readonly field: string; readonly keyField: string }[];
  readonly limit: number;
}
