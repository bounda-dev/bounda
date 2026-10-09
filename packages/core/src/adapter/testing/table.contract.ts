import { beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import type { FieldsRecord } from "../../modules/view.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter } from "../adapter.ts";
import type { Table } from "../ports/table.ts";

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

export interface JsonValuesContractArgs {
  /**
   * A fresh adapter, whose read model the contract opens.
   */
  readonly create: () => Promise<Adapter>;
}

export interface JsonValuesContractFunction {
  (args: JsonValuesContractArgs): void;
}

/**
 * Every JSON value a `json` field can hold comes back as it was stored, whatever its shape.
 */
export const jsonValuesContract: JsonValuesContractFunction = ({ create }) => {
  describe("json values contract", () => {
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
  });
};
