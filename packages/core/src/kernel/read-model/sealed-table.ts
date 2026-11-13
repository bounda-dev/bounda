import type { StoredPersonalField } from "../../adapter/storage/sealed-fields.ts";
import type { FindManyArgs, Table, Where } from "../../adapter/storage/table.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import {
  indexOf,
  type OpenedRow,
  openRow,
  type SealingContext,
  sealedValues,
} from "./sealed-rows.ts";

type Row = Record<string, unknown>;

const SET_OPERATORS: ReadonlySet<string> = new Set(["ne", "in"]);

const isOperators = (field: StoredPersonalField, value: unknown): value is Row =>
  field.definition.type !== "json" &&
  typeof value === "object" &&
  value !== null &&
  !(value instanceof Date) &&
  !Array.isArray(value);

export interface StoredWhereArgs {
  readonly context: Pick<SealingContext, "layout" | "indexer">;
  readonly where: Where<Row> | undefined;
}

export interface StoredWhereFunction {
  (args: StoredWhereArgs): Promise<Where<Row> | undefined>;
}

// `where` on the stored fields: a condition on a sealed field becomes one on its blind index.
// Throws `ConfigurationError` for a sealed field without one, or a range on one.
export const storedWhere: StoredWhereFunction = async ({ context, where }) => {
  if (where === undefined) return undefined;
  const stored: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(where)) {
    const field = context.layout.personal.find(
      (candidate) => candidate.sealed && candidate.field === name,
    );
    if (field === undefined) {
      stored[name] = value;
      continue;
    }
    if (field.indexField === null) {
      throw new ConfigurationError(
        `Read model "${context.layout.readModel}": field "${name}" is sealed at rest and has no blind index, so where cannot match it; give it .index() or .unique()`,
      );
    }
    const index = (given: unknown) =>
      given === null || given === undefined
        ? Promise.resolve(given)
        : indexOf({ context, field, value: given });
    if (!isOperators(field, value)) {
      stored[field.indexField] = await index(value);
      continue;
    }
    const operators: Record<string, unknown> = {};
    for (const [operator, given] of Object.entries(value)) {
      if (!SET_OPERATORS.has(operator)) {
        throw new ConfigurationError(
          `Read model "${context.layout.readModel}": field "${name}" is sealed at rest, so where matches it by equality, ne or in, never by "${operator}"`,
        );
      }
      operators[operator] =
        operator === "in" && Array.isArray(given)
          ? await Promise.all(given.map(index))
          : await index(given);
    }
    stored[field.indexField] = operators;
  }
  return stored as Where<Row>;
};

const checkOrder = (context: Pick<SealingContext, "layout">, args: FindManyArgs<Row>): void => {
  const field = args.orderBy?.field;
  if (
    field !== undefined &&
    context.layout.personal.some((candidate) => candidate.sealed && candidate.field === field)
  ) {
    throw new ConfigurationError(
      `Read model "${context.layout.readModel}": field "${field}" is sealed at rest, so findMany cannot sort by it; keep it in the clear with .personal({ clear: true }) to sort by it in SQL`,
    );
  }
};

export interface SealedTableArgs {
  readonly context: SealingContext;
  // The adapter's table, on the stored fields.
  readonly table: Table<Row>;
  // What each row read went through: a query notes whose rows it read, and leaves out those it may
  // not read.
  readonly read?: (rows: readonly Row[]) => Promise<readonly OpenedRow[]>;
  // The same table without the rows `table` leaves out of its reads, where a patch of personal
  // fields finds the persons of the rows it changes: its writes change those rows too.
  readonly unfiltered?: Table<Row>;
}

export interface SealedTableFunction {
  (args: SealedTableArgs): Table<Row>;
}

export interface OpenRowsFunction {
  (context: SealingContext, rows: readonly Row[]): Promise<readonly OpenedRow[]>;
}

// Every row opened, none left unopened or out: what a projection reads of its own read model.
export const openAll: OpenRowsFunction = (context, rows) =>
  Promise.all(rows.map((stored) => openRow({ context, stored, hideRetained: false })));

// The read model's table as projections and queries use it, over the adapter's: what is written
// goes in sealed, what is read comes out opened. A patch of personal fields that does not name the
// row's person reads the rows it changes first, to seal each under its person's key.
export const sealedTable: SealedTableFunction = ({
  context,
  table,
  read = (rows) => openAll(context, rows),
  unfiltered = table,
}) => {
  const { layout } = context;
  const personOf = (row: Row): string | null => {
    const value = layout.person === null ? undefined : row[layout.person];
    return typeof value === "string" ? value : null;
  };
  const whole = async (row: Row): Promise<Row> =>
    sealedValues({ context, values: row, person: personOf(row), whole: true });
  const opened = async (rows: readonly Row[]): Promise<readonly Row[]> =>
    (await read(rows)).map(({ row }) => row);
  return {
    upsert: async (row) => table.upsert(await whole(row)),
    insert: async (row) => table.insert(await whole(row)),
    update: async (where, patch) => {
      const stored = await storedWhere({ context, where });
      const touches = layout.personal.some(({ field }) => patch[field] !== undefined);
      if (!touches) return table.update(stored ?? {}, patch);
      if (layout.person !== null && typeof patch[layout.person] === "string") {
        const values = await sealedValues({
          context,
          values: patch,
          person: personOf(patch),
          whole: false,
        });
        return table.update(stored ?? {}, values);
      }
      const rows = await unfiltered.findMany(stored === undefined ? {} : { where: stored });
      const persons = new Set(rows.map(personOf));
      for (const person of persons) {
        const values = await sealedValues({ context, values: patch, person, whole: false });
        await table.update(
          layout.person === null ? (stored ?? {}) : { ...stored, [layout.person]: person },
          values,
        );
      }
    },
    delete: async (where) => table.delete((await storedWhere({ context, where })) ?? {}),
    count: async (where) => table.count(await storedWhere({ context, where })),
    findOne: async (where) => {
      const found = await table.findOne((await storedWhere({ context, where })) ?? {});
      return found === null ? null : ((await opened([found]))[0] ?? null);
    },
    findMany: async (args = {}) => {
      checkOrder(context, args);
      const where = await storedWhere({ context, where: args.where });
      return opened(await table.findMany({ ...args, ...(where === undefined ? {} : { where }) }));
    },
  };
};
