import { describe, expect, it } from "vitest";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { reading } from "./reading.ts";

const setUp = async () => {
  const storage = await memory().createReadModel<Record<string, unknown>>({
    name: "customers",
    fields: {
      orderId: f.string().primaryKey(),
      customerId: f.string().optional().person(),
      email: f.string().personal(),
    },
    logger: silentLogger,
  });
  return { storage, stores: reading({ storage, person: "customerId" }) };
};

describe("reading", () => {
  it("notes the person of every row found, repeats included, and of none counted", async () => {
    const { stores } = await setUp();
    const { table } = stores;
    await table.insert({ orderId: "o-1", customerId: "ana", email: "a" });
    await table.insert({ orderId: "o-2", customerId: "bo", email: "b" });
    await table.upsert({ orderId: "o-3", customerId: "ana", email: "c" });
    await table.insert({ orderId: "o-4", email: "d" });
    await table.update({ orderId: "o-3" }, { email: "c2" });
    await table.delete({ orderId: "o-2" });
    expect(await table.count()).toBe(3);
    expect(stores.persons).toEqual([]);

    expect(await table.findOne({ orderId: "o-3" })).toEqual({
      orderId: "o-3",
      customerId: "ana",
      email: "c2",
    });
    expect(await table.findOne({ orderId: "o-2" })).toBeNull();
    expect(await table.findOne({ orderId: "o-4" })).toMatchObject({ email: "d" });
    expect(
      (await table.findMany({ orderBy: { field: "orderId", direction: "asc" } })).map(
        (row) => row.orderId,
      ),
    ).toEqual(["o-1", "o-3", "o-4"]);
    expect(stores.persons).toEqual(["ana", "ana", "ana"]);
  });

  it("notes the rows the client reads, and hands its driver through, noting it was taken", async () => {
    const found = [{ orderId: "o-1", customerId: "ana" }, { orderId: "o-2" }];
    const raw = { driver: true };
    const stores = reading({
      storage: {
        table: (await setUp()).storage.table,
        client: {
          get: async (sql) => (sql === "one" ? (found[0] ?? null) : null),
          all: async () => found,
          raw,
        },
      },
      person: "customerId",
    });
    expect(await stores.client.get("one")).toEqual(found[0]);
    expect(await stores.client.get("none")).toBeNull();
    expect(await stores.client.all("all", [1])).toBe(found);
    expect(stores.unattributed).toBe(false);
    expect(stores.client.raw).toBe(raw);
    expect(stores.unattributed).toBe(true);
    expect(stores.persons).toEqual(["ana", "ana"]);
  });
});
