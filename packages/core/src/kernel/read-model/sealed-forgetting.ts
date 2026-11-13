import { FORGOTTEN_KEY, RETAINED_KEY_PREFIX } from "../../adapter/storage/sealed-fields.ts";
import type { Table } from "../../adapter/storage/table.ts";
import type { StoredEvent } from "../../contracts/event.ts";
import {
  BOUNDA_AGGREGATE,
  PERSONAL_DATA_FORGOTTEN_EVENT,
  type PersonalDataForgottenPayload,
} from "../../modules/bounda-events.ts";
import type { SealedLayout } from "./sealed-rows.ts";
import type { SealingKeys } from "./sealing-keys.ts";

type Row = Record<string, unknown>;

export interface IsForgettingFunction {
  (event: StoredEvent): boolean;
}

export const isForgetting: IsForgettingFunction = (event) =>
  event.aggregateType === BOUNDA_AGGREGATE && event.type === PERSONAL_DATA_FORGOTTEN_EVENT;

export interface ApplyForgettingArgs {
  readonly layout: SealedLayout;
  // The adapter's table, on the stored fields.
  readonly table: Table<Row>;
  // Which category each fingerprint the forgetting kept is, read from the kept key.
  readonly keys: Pick<SealingKeys, "categoryOf">;
  readonly event: StoredEvent;
}

export interface ApplyForgettingFunction {
  (args: ApplyForgettingArgs): Promise<void>;
}

// What a forgetting changes in a read model before its own projection of it runs: the values under
// a key it kept are marked, so queries leave their rows out until the key's retention ends; those
// under a key it destroyed lose their blind index, which would otherwise still tell their value
// apart, and their key field says the key is gone. A key given to the person after the forgetting
// is none of these: what was written under it reads as before. One statement per field: a kept key
// is marked with its fingerprint, and only the fields of its category can hold it. A forgetting
// recorded without fingerprints, before Bounda 0.4.0, empties the indexes of every value of the
// person in the categories it forgot.
export const applyForgetting: ApplyForgettingFunction = async ({ layout, table, keys, event }) => {
  if (layout.person === null) return;
  const { personId, categories, retained, expired, fingerprints } =
    event.payload as PersonalDataForgottenPayload;
  const forgotten = new Set<string>([...categories, ...expired]);
  const kept = new Set<string>(retained);
  const ofPerson = { [layout.person]: personId };
  const keptIn = new Map<string, string[]>();
  for (const fingerprint of kept.size === 0 ? [] : (fingerprints ?? [])) {
    const category = await keys.categoryOf(personId, fingerprint);
    if (category !== null && kept.has(category)) {
      keptIn.set(category, [...(keptIn.get(category) ?? []), fingerprint]);
    }
  }
  for (const field of layout.personal) {
    if (kept.has(field.category)) {
      for (const fingerprint of keptIn.get(field.category) ?? []) {
        await table.update(
          { ...ofPerson, [field.keyField]: fingerprint },
          { [field.keyField]: `${RETAINED_KEY_PREFIX}${fingerprint}` },
        );
      }
      continue;
    }
    if (!forgotten.has(field.category)) continue;
    const index = field.indexField === null ? {} : { [field.indexField]: null };
    if (fingerprints === undefined) {
      if (field.indexField !== null) await table.update(ofPerson, index);
      continue;
    }
    await table.update(
      {
        ...ofPerson,
        [field.keyField]: {
          in: [...fingerprints, ...fingerprints.map((fp) => `${RETAINED_KEY_PREFIX}${fp}`)],
        },
      },
      { [field.keyField]: FORGOTTEN_KEY, ...index },
    );
  }
};
