import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";
import { isRetainedKey } from "../../adapter/storage/restricted-persons.ts";
import {
  RETAINED_KEY_PREFIX,
  type StoredPersonalField,
  storedFields,
  storedPersonalFields,
} from "../../adapter/storage/sealed-fields.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import type { FieldsRecord, FieldType } from "../../modules/view.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";
import {
  isSealed,
  type PersonalKey,
  type SealedValue,
  seal,
  unseal,
} from "../personal-data/crypto.ts";
import type { SealingKeys } from "./sealing-keys.ts";

type Row = Record<string, unknown>;

// How a read model's rows are stored: its fields as the view declares them and as the adapter
// stores them, the one marked `.person()`, and the personal ones with their hidden fields.
export interface SealedLayout {
  readonly readModel: string;
  readonly fields: FieldsRecord;
  readonly stored: FieldsRecord;
  readonly person: string | null;
  readonly personal: readonly StoredPersonalField[];
  // Whether a field is kept in the clear: `client.raw` then reads personal data as it is.
  readonly clear: boolean;
  readonly indexed: boolean;
  // The app's categories, which `rawReadOf` names; unchecked when absent.
  readonly categories?: ReadonlySet<string>;
}

export interface SealedLayoutOfArgs {
  readonly readModel: string;
  readonly fields: FieldsRecord;
  readonly categories?: readonly string[];
}

export interface SealedLayoutOfFunction {
  (args: SealedLayoutOfArgs): SealedLayout;
}

// Throws `ConfigurationError` as `storedFields` does.
export const sealedLayoutOf: SealedLayoutOfFunction = ({ readModel, fields, categories }) => {
  const personal = storedPersonalFields(fields);
  return {
    readModel,
    fields,
    stored: storedFields({ readModel, fields }),
    person: Object.keys(fields).find((field) => fields[field]?.mark === "person") ?? null,
    personal,
    clear: personal.some(({ sealed }) => !sealed),
    indexed: personal.some(({ indexField }) => indexField !== null),
    ...(categories === undefined ? {} : { categories: new Set(categories) }),
  };
};

export interface SealingContext {
  readonly layout: SealedLayout;
  readonly keys: SealingKeys;
  readonly indexer: BlindIndexer | null;
  // The event being projected, `null` outside a projection.
  readonly event: () => StoredEvent | null;
  // Told of each personal value a read opens, with the key it was written under.
  readonly onOpen?: (read: KeyedPerson) => void;
}

const keyText = (key: PersonalKey): string =>
  key.retained ? `${RETAINED_KEY_PREFIX}${key.fingerprint}` : key.fingerprint;

export interface IndexOfArgs {
  readonly context: Pick<SealingContext, "layout" | "indexer">;
  readonly field: StoredPersonalField;
  readonly value: unknown;
}

export interface IndexOfFunction {
  (args: IndexOfArgs): Promise<string>;
}

export interface IndexesOfFunction {
  (args: IndexOfArgs): Promise<readonly string[]>;
}

/**
 * The value's index under every database key the table may be indexed under, for a condition.
 */
export const indexesOf: IndexesOfFunction = ({ context, field, value }) => {
  // A layout with an index field is only opened with an indexer.
  const indexer = context.indexer as BlindIndexer;
  return indexer.indexAll({
    readModel: context.layout.readModel,
    field: field.field,
    type: field.definition.type,
    value,
  });
};

export const indexOf: IndexOfFunction = ({ context, field, value }) => {
  // A layout with an index field is only opened with an indexer.
  const indexer = context.indexer as BlindIndexer;
  return indexer.index({
    readModel: context.layout.readModel,
    field: field.field,
    type: field.definition.type,
    value,
  });
};

export interface SealedValuesArgs {
  readonly context: SealingContext;
  // The values written, by field: a whole row, or the fields a patch changes.
  readonly values: Row;
  // The person the row names, `null` when it names none.
  readonly person: string | null;
  // Whether `values` is a whole row, whose personal fields left out have no value.
  readonly whole: boolean;
}

export interface SealedValuesFunction {
  (args: SealedValuesArgs): Promise<Row>;
}

const isBlank = (value: unknown): boolean => value === undefined || value === null;

// `values` as the adapter stores them: each sealed field as the JSON of its envelope, under the key
// `SealingKeys.forWrite` gives, with its blind index; each personal field's key field. A blank
// sealed field that may be left out stays blank; one that may not is sealed as `null`, so it reads
// as `null` and the column keeps a value. Throws `ConfigurationError` for a personal value of a
// row that names no person.
export const sealedValues: SealedValuesFunction = async ({ context, values, person, whole }) => {
  const stored: Row = { ...values };
  for (const field of context.layout.personal) {
    if (!(field.field in values) && !whole) continue;
    const value = values[field.field];
    if (!whole && value === undefined) continue;
    const optional = field.definition.isOptional;
    if (isBlank(value) && (optional || !field.sealed)) {
      if (field.sealed) stored[field.field] = null;
      stored[field.keyField] = null;
      if (field.indexField !== null) stored[field.indexField] = null;
      continue;
    }
    if (person === null && !isBlank(value)) {
      throw new ConfigurationError(
        `Read model "${context.layout.readModel}": a row writes "${field.field}", marked .personal(), without naming its person in "${context.layout.person}": a personal value is kept under its person's key`,
      );
    }
    const key = await context.keys.forWrite(person, field.category, context.event());
    stored[field.keyField] = keyText(key);
    if (!field.sealed) continue;
    const envelope = await seal({
      key,
      person: person ?? "",
      category: field.category,
      value: isBlank(value) ? null : value,
    });
    stored[field.field] = JSON.stringify(envelope);
    if (field.indexField !== null) {
      stored[field.indexField] = isBlank(value) ? null : await indexOf({ context, field, value });
    }
  }
  return stored;
};

const typed = (type: FieldType, value: unknown): unknown =>
  type === "date" && typeof value === "string" ? new Date(value) : value;

export interface ParseEnvelopeFunction {
  (stored: unknown): SealedValue | null;
}

// The envelope a sealed column holds, `null` for a value that is none.
export const parseEnvelope: ParseEnvelopeFunction = (stored) => {
  if (typeof stored !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isSealed(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// A row as read, opened: its fields as the view declares them, and what reading it touched.
export interface OpenedRow {
  readonly row: Row;
  // The persons the row's sealed values name, its own included.
  readonly persons: readonly string[];
  // Whether a value of the row is under a key a forgetting kept under an erasure exemption.
  readonly retained: boolean;
  // The fields whose value is under such a key.
  readonly retainedFields: readonly string[];
}

export interface OpenRowArgs {
  readonly context: Pick<SealingContext, "layout" | "keys" | "onOpen">;
  // As the adapter decoded it: any of the stored fields, others a statement selected.
  readonly stored: Row;
  // Leaves the values under a key a forgetting kept unopened, as `null`.
  readonly hideRetained: boolean;
}

export interface OpenRowFunction {
  (args: OpenRowArgs): Promise<OpenedRow>;
}

// Opens each sealed field of `stored` under the key its envelope names, `null` once that key is
// gone, and leaves out the hidden fields. A value that is no envelope, which only a write that
// went around the runtime leaves, reads as `null`: nothing in the clear comes out of a sealed
// column.
export const openRow: OpenRowFunction = async ({
  context: { layout, keys, onOpen },
  stored,
  hideRetained,
}) => {
  const row: Row = { ...stored };
  const persons = new Set<string>();
  const own = layout.person === null ? undefined : stored[layout.person];
  if (typeof own === "string") persons.add(own);
  const retainedFields = new Set<string>();
  for (const field of layout.personal) {
    delete row[field.keyField];
    if (field.indexField !== null) delete row[field.indexField];
    const keyText = stored[field.keyField];
    if (isRetainedKey(keyText)) retainedFields.add(field.field);
    const value = stored[field.field];
    if (value === undefined || value === null) continue;
    if (!field.sealed) {
      // A value in the clear is the row's person's, under the key its key field names.
      if (typeof own === "string" && typeof keyText === "string") {
        onOpen?.(
          isRetainedKey(keyText)
            ? {
                person: own,
                fingerprint: keyText.slice(RETAINED_KEY_PREFIX.length),
                retained: true,
              }
            : { person: own, fingerprint: keyText },
        );
      }
      continue;
    }
    const envelope = parseEnvelope(value);
    if (envelope === null) {
      row[field.field] = null;
      continue;
    }
    persons.add(envelope.$personal.person);
    const key = await keys.forOpen(envelope.$personal.person, envelope.$personal.key);
    if (key?.retained === true) retainedFields.add(field.field);
    if (key === null || (key.retained && hideRetained)) {
      row[field.field] = null;
      continue;
    }
    onOpen?.({
      person: envelope.$personal.person,
      fingerprint: envelope.$personal.key,
      ...(key.retained ? { retained: true as const } : {}),
    });
    row[field.field] = typed(field.definition.type, await unseal({ key, sealed: envelope }));
  }
  return {
    row,
    persons: [...persons],
    retained: retainedFields.size > 0,
    retainedFields: [...retainedFields],
  };
};
