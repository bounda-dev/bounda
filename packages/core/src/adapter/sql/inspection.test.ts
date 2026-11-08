import { describe, expect, it } from "vitest";
import { inspectSqlTable, quoteName, storeOfTable } from "./inspection.ts";

describe("quoteName", () => {
  it("double-quotes a name, doubling the quotes in it", () => {
    expect(quoteName("bounda_events")).toBe('"bounda_events"');
    expect(quoteName('odd"name')).toBe('"odd""name"');
  });
});

describe("inspectSqlTable", () => {
  it("reads a table in the order of its key, a keyless one as it comes, and holds the key store's key material opaque", async () => {
    const statements: string[] = [];
    const db = {
      run: async () => {},
      all: async (sql: string) => {
        statements.push(sql);
        return [{ person: "c-1" }];
      },
    };
    expect(
      await inspectSqlTable({
        db,
        prefix: "app_",
        name: "app_personal_keys",
        from: '"s"."app_personal_keys"',
        key: ["person", "kid"],
      }),
    ).toEqual({
      name: "app_personal_keys",
      store: "personalKeys",
      key: ["person", "kid"],
      opaque: ["key", "fingerprint"],
      rows: [{ person: "c-1" }],
    });
    expect(
      await inspectSqlTable({
        db,
        prefix: "app_",
        name: "app_events",
        from: '"app_events"',
        key: [],
      }),
    ).toMatchObject({ opaque: [] });
    expect(statements).toEqual([
      'SELECT * FROM "s"."app_personal_keys" ORDER BY "person", "kid"',
      'SELECT * FROM "app_events"',
    ]);
  });
});

describe("storeOfTable", () => {
  it("names the store a table under the prefix holds, a read model's or its rebuild's, or none", () => {
    expect(storeOfTable({ prefix: "app_", name: "app_events" })).toBe("events");
    expect(storeOfTable({ prefix: "app_", name: "app_person_rows" })).toBe("personRows");
    expect(storeOfTable({ prefix: "app_", name: "app_forget_ledger" })).toBe("forgetLedger");
    expect(storeOfTable({ prefix: "app_", name: "app_rm_orders" })).toBe("readModel");
    expect(storeOfTable({ prefix: "app_", name: "app_rm_orders__rebuild" })).toBe("readModel");
    expect(storeOfTable({ prefix: "app_", name: "app_rm_personal_keys" })).toBe("readModel");
    expect(storeOfTable({ prefix: "app_", name: "app_events_archive" })).toBeNull();
    expect(storeOfTable({ prefix: "app_", name: "bounda_events" })).toBeNull();
  });
});
