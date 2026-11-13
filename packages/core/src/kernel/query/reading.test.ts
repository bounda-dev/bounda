import { describe, expect, it } from "vitest";
import type { RestrictedReads } from "../../adapter/storage/restricted-persons.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { silentLogger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { fieldBuilder as f } from "../../modules/view.ts";
import { reading } from "./reading.ts";

const fields = {
  orderId: f.string().primaryKey(),
  customerId: f.string().optional().person(),
  email: f.string().personal({ category: "profile" }),
};

const setUp = async () => {
  const adapter = memory();
  const storage = await adapter.createReadModel<Record<string, unknown>>({
    name: "customers",
    fields,
    logger: silentLogger,
  });
  const stores = (view: "unrestricted" | "retained" | "all" = "unrestricted") =>
    reading({ storage, readModel: "customers", person: "customerId", personal: ["email"], view });
  return { storage, stores: stores(), storesIn: stores };
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

  it("leaves out of every read the rows of a person restricted as a whole or in a category the read model holds, as its view says", async () => {
    const { storage, storesIn } = await setUp();
    await storage.transact({
      subscriber: "test",
      wait: true,
      work: async ({ table, restrictedPersons }) => {
        for (const [orderId, customerId] of [
          ["o-1", "ana"],
          ["o-2", "bo"],
          ["o-3", "cy"],
          ["o-4", "dan"],
        ] as const) {
          await table.insert({ orderId, customerId, email: `${customerId}@x` });
        }
        await restrictedPersons.request("ana", [{ ground: "legal-claims", categories: null }]);
        await restrictedPersons.request("bo", [
          { ground: "objection-pending", categories: ["marketing"] },
        ]);
        await restrictedPersons.retain("cy", ["profile"]);
      },
    });
    const orders = async (view: "unrestricted" | "retained" | "all") => {
      const { table } = storesIn(view);
      return {
        found: (await table.findMany({ orderBy: { field: "orderId", direction: "asc" } })).map(
          (row) => row.orderId,
        ),
        count: await table.count(),
        ana: await table.findOne({ orderId: "o-1" }),
      };
    };
    expect(await orders("unrestricted")).toEqual({ found: ["o-2", "o-4"], count: 2, ana: null });
    expect(await orders("retained")).toMatchObject({ found: ["o-2", "o-3", "o-4"], count: 3 });
    expect(await orders("all")).toMatchObject({ found: ["o-1", "o-2", "o-3", "o-4"], count: 4 });
    expect(await storage.restricted.among(["ana", "bo", "cy", "dan"], "unrestricted")).toEqual(
      new Set(["ana", "cy"]),
    );
    expect(await storage.restricted.among(["ana", "cy"], "retained")).toEqual(new Set(["ana"]));
    expect(await storage.restricted.among(["ana"], "all")).toEqual(new Set());
  });

  it("drops from what the client reads the rows of the persons its view leaves out, notes the rest, and hands its driver through, noting it was taken", async () => {
    const found = [
      { orderId: "o-1", customerId: "ana", email: "a" },
      { orderId: "o-2", customerId: "bo" },
      { orderId: "o-3" },
    ];
    const raw = { driver: true };
    const asked: string[][] = [];
    const restricted: RestrictedReads<Record<string, unknown>> = {
      unrestricted: {} as never,
      retained: {} as never,
      among: async (persons) => {
        asked.push([...persons]);
        return new Set(persons.filter((person) => person === "bo"));
      },
    };
    const stores = reading({
      storage: {
        table: {} as never,
        client: {
          get: async (sql) =>
            sql === "one" ? (found[0] ?? null) : sql === "bo" ? (found[1] ?? null) : null,
          all: async () => found,
          raw,
        },
        restricted,
      },
      readModel: "customers",
      person: "customerId",
      personal: ["email"],
      view: "unrestricted",
    });
    expect(await stores.client.get("one")).toEqual(found[0]);
    expect(await stores.client.get("bo")).toBeNull();
    expect(await stores.client.get("none")).toBeNull();
    expect(await stores.client.all("all", [1])).toEqual([found[0], found[2]]);
    expect(asked).toEqual([["ana"], ["bo"], [], ["ana", "bo"]]);
    expect(stores.unattributed).toBe(false);
    expect(stores.client.raw).toBe(raw);
    expect(stores.unattributed).toBe(true);
    expect(stores.persons).toEqual(["ana", "ana"]);
  });

  it("reads every row through the client for a view that leaves out nobody, asking nothing", async () => {
    const found = [{ orderId: "o-1", customerId: "ana" }];
    const stores = reading({
      storage: {
        table: {} as never,
        client: { get: async () => null, all: async () => found, raw: null },
        restricted: {
          unrestricted: {} as never,
          retained: {} as never,
          among: () => Promise.reject(new Error("not asked")),
        },
      },
      readModel: "customers",
      person: "customerId",
      personal: [],
      view: "all",
    });
    expect(await stores.client.all("all")).toBe(found);
  });

  it("refuses a row the client reads with a field marked personal and without the one marked person", async () => {
    const stores = reading({
      storage: {
        table: {} as never,
        client: {
          get: async () => ({ email: "a" }),
          all: async () => [{ orderId: "o-1", email: "a" }],
          raw: null,
        },
        restricted: {
          unrestricted: {} as never,
          retained: {} as never,
          among: async () => new Set(),
        },
      },
      readModel: "customers",
      person: "customerId",
      personal: ["email"],
      view: "all",
    });
    await expect(stores.client.all("all")).rejects.toBeInstanceOf(ConfigurationError);
    await expect(stores.client.get("one")).rejects.toThrow(
      'A query of read model "customers" read a field marked .personal() through client without "customerId", the field marked .person(): select it too, so the rows of restricted persons are left out',
    );
  });
});
