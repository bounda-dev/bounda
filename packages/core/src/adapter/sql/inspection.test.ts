import { describe, expect, it } from "vitest";
import { inspectSqlTable, quoteName } from "./inspection.ts";

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
