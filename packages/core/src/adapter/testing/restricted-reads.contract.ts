import { beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import { type FieldsRecord, fieldBuilder as f } from "../../modules/view.ts";
import type { Adapter, ReadModelStorage } from "../adapter.ts";
import type { RestrictedPersonsStore } from "../storage/restricted-persons.ts";
import type { AdapterContractArgs } from "./read-model-transaction.contract.ts";

/**
 * A row of the read model the contract restricts: an order, its customer the person it is about,
 * and a note of theirs in the `profile` category.
 */
export interface RestrictedRow {
  readonly orderId: string;
  readonly customerId: string;
  readonly note?: string;
  readonly total: number;
}

/**
 * Field definitions matching `RestrictedRow`.
 */
export const restrictedFields: FieldsRecord = {
  orderId: f.string().primaryKey(),
  customerId: f.string().index().person(),
  note: f.string().optional().personal({ category: "profile" }),
  total: f.number(),
};

export interface RestrictedReadsContractFunction {
  (args: AdapterContractArgs): void;
}

const SUBSCRIBER = "restrictions:orders";

/**
 * What every adapter's read models must do with the copy of who is restricted kept beside them:
 * leave out of the reads a query makes the rows of the persons it names, in the statement, so a
 * page and a count leave them out first, as each view says. Call it inside a `describe` of the
 * adapter's test file with a factory that returns a fresh adapter.
 */
export const restrictedReadsContract: RestrictedReadsContractFunction = ({ create }) => {
  describe("restricted reads contract", () => {
    let orders: ReadModelStorage<RestrictedRow>;
    let ids: ReadModelStorage<{ readonly customerId: string; readonly total: number }>;
    let plain: ReadModelStorage<{ readonly sku: string; readonly customerId: string }>;

    const write = (work: (store: RestrictedPersonsStore) => Promise<void>) =>
      orders.transact({
        subscriber: SUBSCRIBER,
        wait: true,
        work: ({ restrictedPersons }) => work(restrictedPersons),
      });

    beforeEach(async () => {
      const adapter: Adapter = await create();
      orders = await adapter.createReadModel<RestrictedRow>({
        name: "orders",
        fields: restrictedFields,
        logger: silentLogger,
      });
      ids = await adapter.createReadModel({
        name: "customerIds",
        fields: { customerId: f.string().primaryKey().person(), total: f.number() },
        logger: silentLogger,
      });
      plain = await adapter.createReadModel({
        name: "skus",
        fields: { sku: f.string().primaryKey(), customerId: f.string() },
        logger: silentLogger,
      });
      await plain.table.upsert({ sku: "s-1", customerId: "ana" });
      for (const [orderId, customerId] of [
        ["o-1", "ana"],
        ["o-2", "bo"],
        ["o-3", "cy"],
        ["o-4", "dan"],
        ["o-5", "ana"],
      ] as const) {
        await orders.table.upsert({ orderId, customerId, note: `${customerId} note`, total: 1 });
      }
      for (const customerId of ["ana", "bo", "cy", "dan"]) {
        await ids.table.upsert({ customerId, total: 1 });
      }
    });

    const found = async (table: ReadModelStorage<RestrictedRow>["table"]) =>
      (await table.findMany({ orderBy: { field: "orderId", direction: "asc" } })).map(
        (row) => row.orderId,
      );

    it("reads every row while nobody is restricted", async () => {
      expect(await found(orders.restricted.unrestricted)).toEqual([
        "o-1",
        "o-2",
        "o-3",
        "o-4",
        "o-5",
      ]);
      expect(await orders.restricted.among(["ana", "bo"], "unrestricted")).toEqual(new Set());
    });

    it("leaves out a person restricted as a whole, or in a category of the read model, and a category a forgetting kept unless the view reads it", async () => {
      await write(async (store) => {
        await store.request("ana", [{ ground: "legal-claims", categories: null }]);
        await store.request("bo", [{ ground: "objection-pending", categories: ["marketing"] }]);
        await store.request("cy", [{ ground: "accuracy-contested", categories: ["profile"] }]);
        await store.retain("dan", ["profile"]);
      });
      const { unrestricted, retained } = orders.restricted;
      expect(await found(unrestricted)).toEqual(["o-2"]);
      expect(await unrestricted.count()).toBe(1);
      expect(await unrestricted.count({ customerId: "ana" })).toBe(0);
      expect(await unrestricted.findOne({ orderId: "o-1" })).toBeNull();
      expect(await unrestricted.findOne({ orderId: "o-2" })).toMatchObject({ customerId: "bo" });
      expect(
        (
          await unrestricted.findMany({
            orderBy: { field: "orderId", direction: "desc" },
            limit: 1,
          })
        ).map((row) => row.orderId),
      ).toEqual(["o-2"]);
      expect(await found(retained)).toEqual(["o-2", "o-4"]);
      expect(await retained.count()).toBe(2);
      expect(await found(orders.table)).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5"]);
      expect(
        await orders.restricted.among(["ana", "bo", "cy", "dan", "eve"], "unrestricted"),
      ).toEqual(new Set(["ana", "cy", "dan"]));
      expect(await orders.restricted.among(["dan", "cy", "ana"], "retained")).toEqual(
        new Set(["ana", "cy"]),
      );
      expect(await orders.restricted.among(["ana"], "all")).toEqual(new Set());
      expect(await orders.restricted.among([], "unrestricted")).toEqual(new Set());
    });

    it("leaves out of a read model without personal fields only the persons restricted as a whole", async () => {
      await write(async (store) => {
        await store.request("ana", [{ ground: "legal-claims", categories: null }]);
        await store.request("bo", [{ ground: "objection-pending", categories: ["profile"] }]);
        await store.retain("cy", ["profile"]);
      });
      const rows = await ids.restricted.unrestricted.findMany({
        orderBy: { field: "customerId", direction: "asc" },
      });
      expect(rows.map((row) => row.customerId)).toEqual(["bo", "cy", "dan"]);
      expect(await ids.restricted.among(["ana", "bo", "cy"], "unrestricted")).toEqual(
        new Set(["ana"]),
      );
    });

    it("replaces what a person asked to restrict, keeps what a forgetting kept until released, and leaves writes to the table", async () => {
      await write(async (store) => {
        await store.request("ana", [
          { ground: "legal-claims", categories: null },
          { ground: "objection-pending", categories: ["profile"] },
        ]);
        await store.retain("ana", ["profile", "profile"]);
      });
      await write((store) => store.request("ana", []));
      expect(await orders.restricted.among(["ana"], "unrestricted")).toEqual(new Set(["ana"]));
      expect(await orders.restricted.among(["ana"], "retained")).toEqual(new Set());
      await write((store) => store.release("ana", ["marketing", "profile"]));
      expect(await orders.restricted.among(["ana"], "unrestricted")).toEqual(new Set());
      await write((store) => store.request("ana", [{ ground: "legal-claims", categories: null }]));
      await orders.restricted.unrestricted.upsert({ orderId: "o-6", customerId: "ana", total: 2 });
      await orders.restricted.unrestricted.update({ orderId: "o-6" }, { total: 3 });
      expect(await orders.table.findOne({ orderId: "o-6" })).toMatchObject({ total: 3 });
      await orders.restricted.unrestricted.delete({ orderId: "o-6" });
      expect(await orders.table.findOne({ orderId: "o-6" })).toBeNull();
    });

    it("releases only the categories named of what a forgetting kept for that person, and replaces only that person's requests", async () => {
      await write(async (store) => {
        await store.retain("ana", ["profile"]);
        await store.retain("bo", ["profile"]);
        await store.request("cy", [{ ground: "legal-claims", categories: ["profile"] }]);
        await store.retain("dan", ["profile"]);
      });
      await write(async (store) => {
        await store.release("ana", ["profile"]);
        await store.release("cy", ["profile"]);
        await store.release("dan", ["marketing"]);
        await store.request("bo", []);
      });
      expect(await orders.restricted.among(["ana", "bo", "cy", "dan"], "unrestricted")).toEqual(
        new Set(["bo", "cy", "dan"]),
      );
    });

    it("leaves nobody out of a read model whose rows are no one's", async () => {
      await write((store) => store.request("ana", [{ ground: "legal-claims", categories: null }]));
      expect(await plain.restricted.among(["ana"], "unrestricted")).toEqual(new Set());
      expect(await plain.restricted.unrestricted.count()).toBe(1);
    });

    it("rolls back with the transaction that wrote it", async () => {
      await expect(
        write(async (store) => {
          await store.request("ana", [{ ground: "legal-claims", categories: null }]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await orders.restricted.among(["ana"], "unrestricted")).toEqual(new Set());
    });

    it("tells apart more persons than a statement binds at once", async () => {
      const persons = Array.from({ length: 1_203 }, (_, index) => `p-${index}`);
      await write(async (store) => {
        for (const person of persons.filter((_, index) => index % 400 === 0)) {
          await store.request(person, [{ ground: "legal-claims", categories: null }]);
        }
      });
      expect(await orders.restricted.among(persons, "unrestricted")).toEqual(
        new Set(["p-0", "p-400", "p-800", "p-1200"]),
      );
    });
  });
};
