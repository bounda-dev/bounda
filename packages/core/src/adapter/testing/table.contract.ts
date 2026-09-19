import { beforeEach, describe, expect, it } from "vitest";
import type { FieldsRecord } from "../../modules/view.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
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
