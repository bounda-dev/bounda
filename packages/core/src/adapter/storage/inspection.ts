import { isHiddenField } from "./sealed-fields.ts";

/**
 * The stores of the storage a table can hold, by the name `storageTableNameFor` puts after the
 * prefix, and `readModel` for a read model's table or its rebuild's.
 */
export type InspectedStore =
  | "events"
  | "checkpoints"
  | "inbox"
  | "deadLetters"
  | "scheduledCommands"
  | "idempotencyKeys"
  | "personalKeys"
  | "indexKeys"
  | "persons"
  | "restrictions"
  | "restrictedPersons"
  | "restrictedPositions"
  | "snapshots"
  | "subscriberFailures"
  | "personRows"
  | "forgetLedger"
  | "forgetLedgerMarks"
  | "migrations"
  | "readModel";

/**
 * Every store but `readModel`, whose tables are named after each read model.
 */
export const STORAGE_STORES: readonly Exclude<InspectedStore, "readModel">[] = [
  "events",
  "checkpoints",
  "inbox",
  "deadLetters",
  "scheduledCommands",
  "idempotencyKeys",
  "personalKeys",
  "indexKeys",
  "persons",
  "restrictions",
  "restrictedPersons",
  "restrictedPositions",
  "snapshots",
  "subscriberFailures",
  "personRows",
  "forgetLedger",
  "forgetLedgerMarks",
  "migrations",
];

/**
 * A table of an adapter's database, or what an in-memory store keeps as one, as
 * `Adapter.inspect` reads it: every row as stored, nothing opened.
 */
export interface InspectedTable {
  readonly name: string;
  /**
   * Which store it holds; `null` for a table under the prefix that is none of them.
   */
  readonly store: InspectedStore | null;
  /**
   * The columns that tell its rows apart, so a report can name the row.
   */
  readonly key: readonly string[];
  /**
   * The columns that hold only key material, which is random text: a search compares their values
   * whole and never looks inside them, where a short value would turn up by chance.
   */
  readonly opaque: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}

export interface OpaqueColumnsOfFunction {
  (store: InspectedStore | null, columns: readonly string[]): readonly string[];
}

/**
 * The key material a store keeps: the personal keys, the key of the blind indexes and their
 * fingerprints, and the key and index fields beside the personal fields of a read model.
 */
export const opaqueColumnsOf: OpaqueColumnsOfFunction = (store, columns) => {
  if (store === "personalKeys" || store === "indexKeys") return ["key", "fingerprint"];
  return store === "readModel" ? columns.filter(isHiddenField) : [];
};
