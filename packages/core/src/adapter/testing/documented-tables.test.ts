import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOCUMENTED_TABLES, SQLITE_ONLY_TABLES } from "./documented-tables.ts";

const PAGE = fileURLToPath(
  new URL("../../../../../docs/src/content/docs/adapters/index.mdx", import.meta.url),
);

describe("the tables the adapters' page lists", () => {
  it("are those every engine creates, in the order the contract holds them", async () => {
    const page = await readFile(PAGE, "utf8");
    const section = page.split("## What an adapter creates")[1]?.split("\n## ")[0] ?? "";
    const rows = [...section.matchAll(/^\| `bounda_(\w+)` \| (.*)$/gm)];
    expect(rows.map(([, table]) => table)).toEqual(DOCUMENTED_TABLES);
    expect(
      rows.filter(([, , holds]) => holds?.startsWith("On SQLite")).map(([, table]) => table),
    ).toEqual(SQLITE_ONLY_TABLES);
  });
});
