import type { ReadModelStorage } from "../../adapter/adapter.ts";
import { isRetainedKey, type RestrictionView } from "../../adapter/storage/restricted-persons.ts";
import type { ReadClient, Table } from "../../adapter/storage/table.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { BlindIndexer } from "../personal-data/blind-index.ts";
import { sealedClient } from "../read-model/sealed-client.ts";
import {
  type OpenedRow,
  openRow,
  parseEnvelope,
  type SealedLayout,
} from "../read-model/sealed-rows.ts";
import { sealedTable } from "../read-model/sealed-table.ts";
import type { SealingKeyRing } from "../read-model/sealing-keys.ts";

type Row = Record<string, unknown>;

export interface ReadingStores {
  readonly table: Table<Row>;
  readonly client: ReadClient<Row>;
  /**
   * The persons of the rows read so far, in order, repeats included: the field marked `.person()`,
   * or, where a statement did not select it, the persons its sealed values name.
   */
  readonly persons: readonly string[];
  /**
   * The persons of the rows read so far that held a value under a key a forgetting kept.
   */
  readonly retained: ReadonlySet<string>;
  /**
   * Whether `client.raw` was taken on a read model with a personal field kept in the clear: what
   * the driver reads of it names no one Bounda can see.
   */
  readonly unattributed: boolean;
}

export interface ReadingArgs {
  readonly storage: Pick<ReadModelStorage, "table" | "client" | "restricted">;
  readonly layout: SealedLayout;
  // Fetched for every row a read answers at once, before any of them is opened.
  readonly keys: SealingKeyRing;
  readonly indexer: BlindIndexer | null;
  readonly view: RestrictionView;
}

export interface ReadingFunction {
  (args: ReadingArgs): ReadingStores;
}

// Within the hundred parameters a Durable Object's SQLite binds to one statement.
const KEYS_PER_STATEMENT = 90;

const primaryKeyOf = (layout: SealedLayout): string =>
  Object.keys(layout.fields).find((field) => layout.fields[field]?.isPrimaryKey) as string;

/**
 * A read model's `table` and `client` as a query reads them: values sealed at rest come out
 * opened, and the rows of the persons `view` leaves out are not read, and whose rows they read is
 * noted. `table` leaves them out in the statement itself; `client` drops them from what its SQL
 * answers. A row holding a value under a key a forgetting kept is left out but on a basis that
 * reads it, and its value is never opened then. A sealed value names its person, so a statement
 * need select the field marked `.person()` only beside a personal field kept in the clear, and the
 * primary key or its key field beside such a field of a person a forgetting kept a key of; a row
 * without them is refused. `count` reads no row, so it notes no one; taking `client.raw` is noted
 * as a read of rows whose persons are unknown when a personal field is kept in the clear.
 */
export const reading: ReadingFunction = ({ storage, layout, keys, indexer, view }) => {
  const { table: all, client, restricted } = storage;
  const restricting = layout.person !== null;
  const table = view === "all" || !restricting ? all : restricted[view];
  const persons: string[] = [];
  const retained = new Set<string>();
  let unattributed = false;
  const hideRetained = view === "unrestricted";
  const context = { layout, keys, indexer, event: () => null };
  const note = (opened: OpenedRow): void => {
    const own = layout.person === null ? undefined : opened.row[layout.person];
    const named = typeof own === "string" ? [own] : opened.persons;
    persons.push(...named);
    if (opened.retained) for (const person of named) retained.add(person);
  };
  const open = (stored: Row) => openRow({ context, stored, hideRetained });
  // The persons whose keys the rows need, the row's own and those its envelopes name.
  const fetched = (rows: readonly Row[]) =>
    keys.fetch(
      rows.flatMap((row) => [
        ...(layout.person !== null && typeof row[layout.person] === "string"
          ? [row[layout.person] as string]
          : []),
        ...layout.personal.flatMap(({ field, sealed }) => {
          const envelope = sealed ? parseEnvelope(row[field]) : null;
          return envelope === null ? [] : [envelope.$personal.person];
        }),
      ]),
    );
  const fromTable = async (rows: readonly Row[]): Promise<readonly OpenedRow[]> => {
    await fetched(rows);
    const opened = await Promise.all(rows.map(open));
    const kept = hideRetained ? opened.filter((row) => !row.retained) : opened;
    for (const row of kept) note(row);
    return kept;
  };
  // A clear value whose key field the statement did not select, of a person a forgetting kept a key
  // of in its category: the row's key field, read by its primary key, says whether it is under it.
  const keptInClear = async (rows: readonly Row[]): Promise<ReadonlySet<Row>> => {
    if (!hideRetained || layout.person === null) return new Set();
    const person = layout.person;
    const clear = layout.personal.filter((field) => !field.sealed);
    const unknown: Row[] = [];
    for (const row of rows) {
      const owner = row[person];
      if (typeof owner !== "string") continue;
      const unsure = clear.filter(
        (field) => row[field.field] !== undefined && !(field.keyField in row),
      );
      const kept = await Promise.all(unsure.map((field) => keys.kept(owner, field.category)));
      if (kept.some(Boolean)) unknown.push(row);
    }
    if (unknown.length === 0) return new Set();
    const key = primaryKeyOf(layout);
    if (unknown.some((row) => row[key] === undefined)) {
      throw new ConfigurationError(
        `A query of read model "${layout.readModel}" read a field marked .personal({ clear: true }) of a person a forgetting kept a key of through client without "${key}", its primary key: select it too, so the rows under that key are left out`,
      );
    }
    const marked = new Set<unknown>();
    for (let start = 0; start < unknown.length; start += KEYS_PER_STATEMENT) {
      const chunk = unknown.slice(start, start + KEYS_PER_STATEMENT).map((row) => row[key]);
      for (const stored of await all.findMany({ where: { [key]: { in: chunk } } })) {
        if (clear.some((field) => isRetainedKey(stored[field.keyField]))) marked.add(stored[key]);
      }
    }
    return new Set(unknown.filter((row) => marked.has(row[key])));
  };
  const fromClient = async (rows: readonly Row[]): Promise<readonly OpenedRow[]> => {
    if (layout.person !== null) {
      const person = layout.person;
      for (const row of rows) {
        const clear = layout.personal.some(
          (field) => !field.sealed && row[field.field] !== undefined,
        );
        if (clear && row[person] === undefined) {
          throw new ConfigurationError(
            `A query of read model "${layout.readModel}" read a field marked .personal({ clear: true }) through client without "${person}", the field marked .person(): select it too, so the rows of restricted persons are left out`,
          );
        }
      }
    }
    await fetched(rows);
    const kept = await keptInClear(rows);
    const opened = (await Promise.all(rows.map(open))).map((row, index) =>
      kept.has(rows[index] as Row) ? { ...row, retained: true } : row,
    );
    const visible = hideRetained ? opened.filter((row) => !row.retained) : opened;
    if (view === "all" || !restricting) {
      for (const row of visible) note(row);
      return visible;
    }
    const named = (row: OpenedRow): readonly string[] => {
      const own = layout.person === null ? undefined : row.row[layout.person];
      return typeof own === "string" ? [own] : row.persons;
    };
    const leftOut = await restricted.among([...new Set(visible.flatMap(named))], view);
    const read = visible.filter((row) => !named(row).some((person) => leftOut.has(person)));
    for (const row of read) note(row);
    return read;
  };
  return {
    persons,
    retained,
    get unattributed() {
      return unattributed;
    },
    table: sealedTable({ context, table, read: fromTable, unfiltered: all }),
    client: sealedClient({
      context,
      client,
      read: fromClient,
      onRaw: () => {
        if (layout.clear) unattributed = true;
      },
    }),
  };
};
