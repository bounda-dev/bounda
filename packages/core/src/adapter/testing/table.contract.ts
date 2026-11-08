import { beforeEach, describe, expect, it } from "vitest";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter } from "../adapter.ts";
import type { Table, Where } from "../storage/table.ts";

/**
 * The read model every table contract test uses.
 */
export interface ContractRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly status: string;
  readonly total: number;
  readonly paidAt?: Date;
}

/**
 * Field definitions matching `ContractRow`.
 */
export const contractFields: FieldsRecord = {
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  status: f.string(),
  total: f.number(),
  paidAt: f.date().optional(),
};

export interface TableContractArgs {
  readonly create: () => Promise<Table<ContractRow>>;
}

export interface TableContractFunction {
  (args: TableContractArgs): void;
}

const row = (orderId: string, overrides: Partial<ContractRow> = {}): ContractRow => ({
  orderId,
  customerId: "c-1",
  status: "placed",
  total: 10,
  ...overrides,
});

/**
 * The behaviour every read-model table must exhibit.
 */
export const tableContract: TableContractFunction = ({ create }) => {
  describe("table contract", () => {
    let table: Table<ContractRow>;

    beforeEach(async () => {
      table = await create();
    });

    it("upserts by primary key and reads back", async () => {
      await table.upsert(row("1"));
      await table.upsert(row("1", { status: "paid", total: 20 }));
      expect(await table.findOne({ orderId: "1" })).toEqual(
        row("1", { status: "paid", total: 20 }),
      );
      expect(await table.count()).toBe(1);
    });

    it("ignores an insert that repeats the primary key", async () => {
      await table.insert(row("1"));
      await table.insert(row("1", { total: 99 }));
      expect(await table.findOne({ orderId: "1" })).toEqual(row("1"));
    });

    it("updates and deletes matching rows and does nothing otherwise", async () => {
      await table.insert(row("1"));
      await table.insert(row("2", { customerId: "c-2" }));
      const paidAt = new Date("2026-01-02T00:00:00.000Z");
      await table.update({ orderId: "1" }, { status: "paid", paidAt });
      await table.update({ orderId: "missing" }, { status: "paid" });
      expect(await table.findOne({ orderId: "1" })).toEqual(row("1", { status: "paid", paidAt }));
      expect((await table.findOne({ orderId: "2" }))?.status).toBe("placed");
      await table.delete({ customerId: "c-2" });
      await table.delete({ orderId: "missing" });
      expect(await table.count()).toBe(1);
    });

    it("finds many with where, order, limit and offset", async () => {
      await table.insert(row("1", { total: 30 }));
      await table.insert(row("2", { total: 10, customerId: "c-2" }));
      await table.insert(row("3", { total: 20 }));
      const all = await table.findMany({ orderBy: { field: "total", direction: "asc" } });
      expect(all.map((entry) => entry.orderId)).toEqual(["2", "3", "1"]);
      const mine = await table.findMany({
        where: { customerId: "c-1" },
        orderBy: { field: "total", direction: "desc" },
      });
      expect(mine.map((entry) => entry.orderId)).toEqual(["1", "3"]);
      const page = await table.findMany({
        orderBy: { field: "total", direction: "asc" },
        limit: 1,
        offset: 1,
      });
      expect(page.map((entry) => entry.orderId)).toEqual(["3"]);
      expect(await table.count({ customerId: "c-1" })).toBe(2);
      expect(await table.count()).toBe(3);
      const narrowed = await table.findMany({ where: { customerId: "c-2", total: 10 } });
      expect(narrowed.map((entry) => entry.orderId)).toEqual(["2"]);
      expect(await table.findMany({ where: { customerId: "c-2", total: 99 } })).toEqual([]);
      const equalTotals = await table.findMany({
        where: { customerId: "c-1" },
        orderBy: { field: "customerId", direction: "desc" },
      });
      expect(equalTotals.map((entry) => entry.orderId).sort()).toEqual(["1", "3"]);
      expect(await table.findOne({ orderId: "missing" })).toBeNull();
    });

    it("stores optional fields as absent, not null", async () => {
      await table.insert(row("1"));
      const found = await table.findOne({ orderId: "1" });
      expect(found).not.toBeNull();
      expect(Object.hasOwn(found as object, "paidAt")).toBe(false);
    });

    it("matches a date by its instant and a missing value by null or undefined", async () => {
      await table.insert(row("1", { paidAt: new Date("2026-01-01T00:00:00.000Z") }));
      await table.insert(row("2"));
      await table.upsert({ ...row("3"), paidAt: null as never });
      const ids = async (where: Where<ContractRow>) =>
        (await table.findMany({ where, orderBy: { field: "orderId", direction: "asc" } })).map(
          (found) => found.orderId,
        );
      expect(await ids({ paidAt: new Date("2026-01-01T00:00:00.000Z") })).toEqual(["1"]);
      expect(await ids({ paidAt: undefined } as never)).toEqual(["2", "3"]);
      expect(await ids({ paidAt: null as never })).toEqual(["2", "3"]);
      expect(Object.hasOwn((await table.findOne({ orderId: "3" })) as object, "paidAt")).toBe(
        false,
      );
    });

    it("leaves a field out of an update whose patch is undefined", async () => {
      const paidAt = new Date("2026-01-01T00:00:00.000Z");
      await table.insert(row("1", { paidAt }));
      await table.update({ orderId: "1" }, { status: "paid", paidAt: undefined } as never);
      expect(await table.findOne({ orderId: "1" })).toEqual(row("1", { status: "paid", paidAt }));
    });

    it("hands out rows that changing does not change the table", async () => {
      await table.insert(row("1"));
      const found = (await table.findOne({ orderId: "1" })) as { status: string };
      found.status = "changed";
      expect(await table.findOne({ orderId: "1" })).toEqual(row("1"));
    });

    it("filters by range, inequality and membership in every call that takes a where", async () => {
      const day = (n: number) => new Date(`2026-01-0${n}T00:00:00.000Z`);
      await table.insert(row("a", { total: 10, paidAt: day(1) }));
      await table.insert(row("b", { total: 20, status: "paid", paidAt: day(2) }));
      await table.insert(row("c", { total: 30, customerId: "c-2", paidAt: day(3) }));
      await table.insert(row("d", { total: 40, status: "cancelled" }));
      const ids = async (where: Where<ContractRow>) =>
        (await table.findMany({ where, orderBy: { field: "orderId", direction: "asc" } })).map(
          (found) => found.orderId,
        );
      expect(await ids({ total: { gt: 20 } })).toEqual(["c", "d"]);
      expect(await ids({ total: { gte: 20 } })).toEqual(["b", "c", "d"]);
      expect(await ids({ total: { lt: 20 } })).toEqual(["a"]);
      expect(await ids({ total: { lte: 20 } })).toEqual(["a", "b"]);
      expect(await ids({ total: { gt: 10, lt: 40 } })).toEqual(["b", "c"]);
      expect(await ids({ total: { gt: 10, lt: 40 }, customerId: "c-1" })).toEqual(["b"]);
      expect(await ids({ orderId: { gt: "b" } })).toEqual(["c", "d"]);
      expect(await ids({ orderId: { gte: "b", lt: "d" } })).toEqual(["b", "c"]);
      expect(await ids({ paidAt: { gte: day(2) } })).toEqual(["b", "c"]);
      expect(await ids({ paidAt: { lt: day(3) } })).toEqual(["a", "b"]);
      expect(await ids({ status: { ne: "placed" } })).toEqual(["b", "d"]);
      expect(await ids({ paidAt: { ne: day(1) } })).toEqual(["b", "c", "d"]);
      expect(await ids({ paidAt: { ne: null } })).toEqual(["a", "b", "c"]);
      expect(await ids({ status: { in: ["paid", "cancelled"] } })).toEqual(["b", "d"]);
      expect(await ids({ paidAt: { in: [day(1), day(3)] } })).toEqual(["a", "c"]);
      expect(await ids({ status: { in: [] } })).toEqual([]);
      expect(await ids({ total: { gt: undefined, lt: 20 } })).toEqual(["a"]);
      expect(await table.findOne({ total: { gt: 30 } })).toEqual(
        row("d", { total: 40, status: "cancelled" }),
      );
      expect(await table.count({ total: { gte: 20 }, status: { ne: "cancelled" } })).toBe(2);
      await table.update({ total: { lte: 20 } }, { status: "archived" });
      expect(await ids({ status: "archived" })).toEqual(["a", "b"]);
      await table.delete({ orderId: { in: ["a", "c"] } });
      expect(await ids({})).toEqual(["b", "d"]);
    });

    it("orders, ranges and pages strings by code point, case, accents and punctuation included", async () => {
      const byCodePoint = ["B", "Z", "a", "a b", "a-b", "ab", "b", "á", "ｱ", "😀"];
      for (const orderId of ["b", "á", "B", "a-b", "😀", "Z", "ab", "a", "ｱ", "a b"]) {
        await table.insert(row(orderId));
      }
      const ids = async (where: Where<ContractRow>, direction: "asc" | "desc" = "asc") =>
        (await table.findMany({ where, orderBy: { field: "orderId", direction } })).map(
          (found) => found.orderId,
        );
      expect(await ids({})).toEqual(byCodePoint);
      expect(await ids({}, "desc")).toEqual([...byCodePoint].reverse());
      expect(await ids({ orderId: { gt: "Z" } })).toEqual(byCodePoint.slice(2));
      expect(await ids({ orderId: { gte: "a", lt: "b" } })).toEqual(["a", "a b", "a-b", "ab"]);
      expect(await ids({ orderId: { lte: "ab" }, status: "placed" })).toEqual(
        byCodePoint.slice(0, 6),
      );
      const pages: string[][] = [];
      let after: string | undefined;
      for (;;) {
        const page = await table.findMany({
          where: after === undefined ? {} : { orderId: { gt: after } },
          orderBy: { field: "orderId", direction: "asc" },
          limit: 3,
        });
        if (page.length === 0) break;
        pages.push(page.map((found) => found.orderId));
        after = page.at(-1)?.orderId;
      }
      expect(pages).toEqual([
        byCodePoint.slice(0, 3),
        byCodePoint.slice(3, 6),
        byCodePoint.slice(6, 9),
        byCodePoint.slice(9),
      ]);
    });

    it("puts rows without a value first in ascending order and last in descending", async () => {
      const day = (n: number) => new Date(`2026-01-0${n}T00:00:00.000Z`);
      await table.insert(row("a", { paidAt: day(2) }));
      await table.insert(row("b"));
      await table.insert(row("c", { paidAt: day(1) }));
      const ids = async (direction: "asc" | "desc") =>
        (await table.findMany({ orderBy: { field: "paidAt", direction } })).map(
          (found) => found.orderId,
        );
      expect(await ids("asc")).toEqual(["b", "c", "a"]);
      expect(await ids("desc")).toEqual(["a", "c", "b"]);
    });

    it("refuses an operator it does not know, an operand that is null, and operators without a value", async () => {
      const refused = (where: Record<string, unknown>) =>
        expect(table.findMany({ where: where as Where<ContractRow> })).rejects.toBeInstanceOf(
          ConfigurationError,
        );
      await refused({ total: { above: 1 } });
      await refused({ total: { gt: null } });
      await refused({ status: { in: "paid" } });
      await refused({ status: { in: ["paid", null] } });
      await refused({ total: {} });
      await expect(
        table.delete({ orderId: { in: undefined } } as Where<ContractRow>),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        table.count({ total: { between: 1 } } as Where<ContractRow>),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        table.delete({ total: { between: 1 } } as Where<ContractRow>),
      ).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        table.update({ total: { between: 1 } } as Where<ContractRow>, { status: "x" }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("refuses a negative limit or offset and a field the view does not have", async () => {
      await expect(table.findMany({ limit: -1 })).rejects.toBeInstanceOf(ConfigurationError);
      await expect(table.findMany({ offset: -1 })).rejects.toBeInstanceOf(ConfigurationError);
      await expect(
        table.findMany({ where: { missing: "x" } as Where<ContractRow> }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
};

interface JsonRow {
  readonly id: string;
  readonly value: unknown;
}

const jsonFields: FieldsRecord = {
  id: f.string().primaryKey(),
  value: f.json(),
};

interface PersonRow {
  readonly id: string;
  readonly email: string;
  readonly handle?: string;
}

const personFields: FieldsRecord = {
  id: f.string().primaryKey(),
  email: f.string().unique(),
  handle: f.string().optional().unique(),
};

interface FlagRow {
  readonly id: string;
  readonly active?: boolean;
  readonly value: unknown;
}

const flagFields: FieldsRecord = {
  id: f.string().primaryKey(),
  active: f.boolean().optional(),
  value: f.json(),
};

export interface ViewContractArgs {
  /**
   * A fresh adapter, whose read models the contract opens.
   */
  readonly create: () => Promise<Adapter>;
}

export interface ViewContractFunction {
  (args: ViewContractArgs): void;
}

/**
 * What a view's fields promise on every adapter: any JSON value comes back as it was stored, a
 * `unique()` field or the primary key refuses a value another row has, even through an update,
 * though rows may share having none, a required field refuses none, and a view with more than one
 * primary key is refused.
 */
export const viewContract: ViewContractFunction = ({ create }) => {
  describe("view contract", () => {
    it("round-trips any JSON value, top-level strings and booleans included", async () => {
      const { table } = await (await create()).createReadModel<JsonRow>({
        name: "documents",
        fields: jsonFields,
        logger: silentLogger,
      });
      const values: readonly unknown[] = [
        "pending",
        "42",
        "true",
        "",
        true,
        false,
        0,
        12.5,
        [true, false],
        [],
        ["a", 1, { b: null }],
        { nested: { list: [1, "two", false] } },
      ];
      for (const [index, value] of values.entries()) {
        await table.upsert({ id: String(index), value });
      }
      for (const [index, value] of values.entries()) {
        expect(await table.findOne({ id: String(index) })).toEqual({ id: String(index), value });
      }
    });

    it("refuses a value a unique field already has, and a required field left out", async () => {
      const { table } = await (await create()).createReadModel<PersonRow>({
        name: "people",
        fields: personFields,
        logger: silentLogger,
      });
      await table.insert({ id: "1", email: "ada@example.com" });
      await table.upsert({ id: "1", email: "ada@example.com" });
      await expect(table.insert({ id: "2", email: "ada@example.com" })).rejects.toThrow();
      await table.insert({ id: "2", email: "grace@example.com" });
      await expect(table.update({ id: "2" }, { email: "ada@example.com" })).rejects.toThrow();
      await expect(table.update({ id: "2" }, { email: null } as never)).rejects.toThrow();
      await expect(table.upsert({ id: "3" } as PersonRow)).rejects.toThrow();
      expect(await table.count()).toBe(2);
      expect(await table.count({ handle: null } as never)).toBe(2);
    });

    it("refuses a whole update that would give two rows one key or one unique value", async () => {
      const { table } = await (await create()).createReadModel<PersonRow>({
        name: "people",
        fields: personFields,
        logger: silentLogger,
      });
      const rows = [
        { id: "1", email: "ada@example.com" },
        { id: "2", email: "grace@example.com" },
      ];
      for (const row of rows) await table.insert(row);
      await expect(table.update({ id: "1" }, { id: "2" })).rejects.toThrow();
      await expect(table.update({}, { id: "3" })).rejects.toThrow();
      await expect(table.update({}, { email: "same@example.com" })).rejects.toThrow();
      await expect(table.insert({ id: "1" } as PersonRow)).rejects.toThrow();
      expect(await table.findMany({ orderBy: { field: "id", direction: "asc" } })).toEqual(rows);
    });

    it("filters a boolean by inequality and membership but not by range, and a JSON value by equality only", async () => {
      const { table } = await (await create()).createReadModel<FlagRow>({
        name: "flags",
        fields: flagFields,
        logger: silentLogger,
      });
      await table.insert({ id: "1", active: true, value: { gt: 1 } });
      await table.insert({ id: "2", active: false, value: 2 });
      await table.insert({ id: "3", value: [1] });
      const ids = async (where: Where<FlagRow>) =>
        (await table.findMany({ where, orderBy: { field: "id", direction: "asc" } })).map(
          (found) => found.id,
        );
      expect(await ids({ active: { ne: true } })).toEqual(["2", "3"]);
      expect(await ids({ active: { in: [false] } })).toEqual(["2"]);
      expect(await ids({ active: { ne: null } })).toEqual(["1", "2"]);
      expect(await ids({ value: { gt: 1 } })).toEqual(["1"]);
      expect(await ids({ value: [1] })).toEqual(["3"]);
      for (const operator of ["gt", "gte", "lt", "lte"]) {
        await expect(
          table.findMany({ where: { active: { [operator]: false } } as Where<FlagRow> }),
        ).rejects.toThrow(
          new ConfigurationError(
            `Field "active": a boolean has no order for "${operator}"; use ne or in`,
          ),
        );
      }
    });

    it("refuses a view with more than one primary key", async () => {
      await expect(
        (await create()).createReadModel({
          name: "pairs",
          fields: { left: f.string().primaryKey(), right: f.string().primaryKey() },
          logger: silentLogger,
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
};
