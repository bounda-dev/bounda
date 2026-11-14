import type { SealedValue } from "../../adapter/storage/personal-key-store.ts";
import type { Table } from "../../adapter/storage/table.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_REDACTED_EVENT,
  type PersonalDataRedactedPayload,
} from "../../modules/bounda-events.ts";
import { unseal } from "../personal-data/crypto.ts";
import { type RedactedValue, redactedMatcher } from "../personal-data/redaction.ts";
import { openRow, type SealingContext, sealedValues } from "./sealed-rows.ts";
import { primaryKeyOf } from "./sealed-settle.ts";

type Row = Record<string, unknown>;

const PAGE = 100;

export interface IsRedactionFunction {
  (event: StoredEvent): boolean;
}

export const isRedaction: IsRedactionFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_REDACTED_EVENT;

export interface ApplyRedactionArgs {
  readonly context: SealingContext;
  // The adapter's table, on the stored fields.
  readonly table: Table<Row>;
  readonly event: StoredEvent;
  // The old values as the redaction kept them, sealed under the person's keys; none once every
  // read model passed it, or when it kept none.
  readonly values: readonly SealedValue[];
}

export interface ApplyRedactionFunction {
  (args: ApplyRedactionArgs): Promise<void>;
}

// What a redaction changes in a read model before its own projection of it runs: every personal
// field of the person's rows that holds an old value, equal to it as JSON keeps it or quoting it
// as `expectRedacted` finds a value, reads `null` from then on, written as a projection would
// write it, its blind index with it.
export const applyRedaction: ApplyRedactionFunction = async ({ context, table, event, values }) => {
  const { layout } = context;
  if (layout.person === null || layout.personal.length === 0) return;
  const { personId } = event.payload as PersonalDataRedactedPayload;
  const old: RedactedValue[] = [];
  for (const sealed of values) {
    const key = await context.keys.forOpen(personId, sealed.$personal.key);
    if (key !== null) old.push({ category: "", value: await unseal({ key, sealed }), sealed });
  }
  if (old.length === 0) return;
  const matcher = redactedMatcher(personId, old);
  const primaryKey = primaryKeyOf(context);
  for (let after: unknown; ; ) {
    const rows = await table.findMany({
      where: {
        [layout.person]: personId,
        ...(after === undefined ? {} : { [primaryKey]: { gt: after } }),
      },
      orderBy: { field: primaryKey, direction: "asc" },
      limit: PAGE,
    });
    for (const stored of rows) {
      const { row } = await openRow({ context, stored, hideRetained: false });
      const patch: Row = {};
      for (const { field, sealed } of layout.personal) {
        const value = sealed ? row[field] : stored[field];
        if (value !== undefined && value !== null && matcher.holds(value)) {
          patch[field] = null;
        }
      }
      if (Object.keys(patch).length === 0) continue;
      await table.update(
        { [primaryKey]: stored[primaryKey] },
        await sealedValues({ context, values: patch, person: personId, whole: false }),
      );
    }
    after = rows.at(-1)?.[primaryKey];
    if (rows.length < PAGE) return;
  }
};
