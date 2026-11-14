import type { ReadModelTransaction } from "../../adapter/adapter.ts";
import { RETAINED_KEY_PREFIX } from "../../adapter/storage/sealed-fields.ts";
import type { Table } from "../../adapter/storage/table.ts";
import type { FieldType } from "../../modules/view.ts";
import { seal, unseal } from "../personal-data/crypto.ts";
import { digest } from "./fingerprint.ts";
import { indexOf, parseEnvelope, type SealingContext, sealedValues } from "./sealed-rows.ts";

type Row = Record<string, unknown>;

// How many rows a settling reads at a time.
const SETTLE_BATCH = 100;

// A value stored in the clear in a column now sealed, as the column decoded it.
const clearValue = (type: FieldType, text: string): unknown => {
  if (type === "date") return new Date(text);
  if (type !== "json") return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export interface SettledPatchArgs {
  readonly context: SealingContext;
  readonly stored: Row;
}

export interface SettledPatchFunction {
  (args: SettledPatchArgs): Promise<Row | null>;
}

// What a stored row needs to read as the runtime writes it, `null` when nothing: a value in the
// clear in a sealed field is sealed; an envelope in a field now kept in the clear is opened, unless
// its key is gone from a field that needs a value; a missing key field or blind index is filled.
export const settledPatch: SettledPatchFunction = async ({ context, stored }) => {
  const { layout, keys } = context;
  const person = layout.person === null ? null : stored[layout.person];
  const owner = typeof person === "string" ? person : null;
  const patch: Row = {};
  for (const field of layout.personal) {
    const value = stored[field.field];
    if (value === undefined || value === null) continue;
    const envelope = parseEnvelope(value);
    if (field.sealed && envelope === null) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const clear = clearValue(field.definition.type, text);
      if (owner !== null) {
        Object.assign(
          patch,
          await sealedValues({
            context,
            values: { [field.field]: clear },
            person: owner,
            whole: false,
          }),
        );
        continue;
      }
      // A value of no one is sealed under a key no one keeps: never read, and never in the clear.
      const key = await keys.forWrite(null, field.category, null);
      patch[field.field] = JSON.stringify(
        await seal({ key, person: "", category: field.category, value: clear }),
      );
      patch[field.keyField] = key.fingerprint;
      if (field.indexField !== null) patch[field.indexField] = null;
      continue;
    }
    if (envelope === null) {
      if (stored[field.keyField] === undefined || stored[field.keyField] === null) {
        const key = await keys.forWrite(owner, field.category, null);
        patch[field.keyField] = key.retained
          ? `${RETAINED_KEY_PREFIX}${key.fingerprint}`
          : key.fingerprint;
      }
      continue;
    }
    const missingKey = stored[field.keyField] === undefined || stored[field.keyField] === null;
    const missingIndex =
      field.indexField !== null &&
      (stored[field.indexField] === undefined || stored[field.indexField] === null);
    if (field.sealed && !missingKey && !missingIndex) continue;
    const { person: sealedFor, key: fingerprint } = envelope.$personal;
    const key = await keys.forOpen(sealedFor, fingerprint);
    const opened = key === null ? null : await unseal({ key, sealed: envelope });
    if (missingKey) {
      patch[field.keyField] =
        key?.retained === true ? `${RETAINED_KEY_PREFIX}${fingerprint}` : fingerprint;
    }
    if (field.sealed) {
      if (missingIndex && field.indexField !== null && opened !== null) {
        patch[field.indexField] = await indexOf({ context, field, value: opened });
      }
      continue;
    }
    if (opened === null && !field.definition.isOptional) continue;
    patch[field.field] =
      field.definition.type === "date" && typeof opened === "string" ? new Date(opened) : opened;
  }
  return Object.keys(patch).length === 0 ? null : patch;
};

export interface PrimaryKeyOfFunction {
  (context: Pick<SealingContext, "layout">): string;
}

export const primaryKeyOf: PrimaryKeyOfFunction = (context) =>
  Object.keys(context.layout.fields).find(
    (field) => context.layout.fields[field]?.isPrimaryKey,
  ) as string;

export interface SettleUnsettledArgs {
  readonly context: SealingContext;
  readonly transaction: Pick<ReadModelTransaction, "table" | "unsettled">;
}

export interface SettleUnsettledFunction {
  (args: SettleUnsettledArgs): Promise<void>;
}

// Seals, in the transaction, what a projection wrote through `client.raw` into a personal field,
// so nothing it wrote in the clear commits.
export const settleUnsettled: SettleUnsettledFunction = async ({ context, transaction }) => {
  const key = primaryKeyOf(context);
  const sealed = context.layout.personal.filter((field) => field.sealed).map(({ field }) => field);
  const keyed = context.layout.personal.map(({ field, keyField }) => ({ field, keyField }));
  for (;;) {
    const rows = await transaction.unsettled({ sealed, keyed, limit: SETTLE_BATCH });
    let settled = 0;
    for (const stored of rows) {
      const patch = await settledPatch({ context, stored });
      if (patch === null) continue;
      await transaction.table.update({ [key]: stored[key] }, patch);
      settled += 1;
    }
    if (rows.length < SETTLE_BATCH || settled === 0) return;
  }
};

export interface SettlePageArgs {
  readonly context: SealingContext;
  // The adapter's table, on the stored fields.
  readonly table: Table<Row>;
  // The primary key of the last row settled before, `undefined` for the first page.
  readonly after: unknown;
}

export interface SettlePageFunction {
  (args: SettlePageArgs): Promise<{ readonly last: unknown; readonly done: boolean }>;
}

// Settles one page of rows in primary key order: what a read model goes through once after its
// personal fields change, so rows written before read as those written after.
export const settlePage: SettlePageFunction = async ({ context, table, after }) => {
  const key = primaryKeyOf(context);
  const rows = await table.findMany({
    ...(after === undefined ? {} : { where: { [key]: { gt: after } } }),
    orderBy: { field: key, direction: "asc" },
    limit: SETTLE_BATCH,
  });
  for (const stored of rows) {
    const patch = await settledPatch({ context, stored });
    if (patch !== null) await table.update({ [key]: stored[key] }, patch);
  }
  return { last: rows.at(-1)?.[key], done: rows.length < SETTLE_BATCH };
};

export interface SettledMarkFunction {
  (readModel: string): string;
}

// The checkpoint row that names the layout of personal fields a read model's rows were last
// settled for.
export const settledMark: SettledMarkFunction = (readModel) => `read-model:settled:${readModel}`;

export interface LayoutDigestFunction {
  (context: Pick<SealingContext, "layout">): number;
}

// The layout of personal fields as a number a checkpoint keeps: what changes it is what a settling
// has to go through the rows for. Never 0, which a checkpoint never written reads as.
export const layoutDigest: LayoutDigestFunction = ({ layout }) =>
  Number.parseInt(
    digest(
      JSON.stringify(
        layout.personal.map(({ field, category, sealed, indexField }) => [
          field,
          category,
          sealed,
          indexField,
        ]),
      ),
    ).slice(0, 8),
    16,
  ) || 1;
