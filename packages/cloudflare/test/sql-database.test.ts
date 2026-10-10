import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createDurableSqlDatabase } from "../src/sql-database.ts";

const fresh = () => env.STORE.get(env.STORE.newUniqueId());

describe("createDurableSqlDatabase", () => {
  it("runs statements, binds booleans as integers and reads rows back", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const db = createDurableSqlDatabase(state.storage);
      await db.run('CREATE TABLE "t" ("id" TEXT PRIMARY KEY, "ok" INTEGER NOT NULL)', []);
      await db.run('INSERT INTO "t" ("id", "ok") VALUES (?, ?)', ["a", true]);
      expect(await db.all('SELECT "id", "ok" FROM "t"', [])).toEqual([{ id: "a", ok: 1 }]);
    });
  });

  it("commits a write transaction and rolls back one that throws", async () => {
    await runInDurableObject(fresh(), async (_instance, state) => {
      const db = createDurableSqlDatabase(state.storage);
      await db.run('CREATE TABLE "t" ("id" TEXT PRIMARY KEY)', []);
      await db.write(async (tx) => tx.run('INSERT INTO "t" ("id") VALUES (?)', ["kept"]));
      await expect(
        db.write(async (tx) => {
          await tx.run('INSERT INTO "t" ("id") VALUES (?)', ["lost"]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await db.all('SELECT "id" FROM "t"', [])).toEqual([{ id: "kept" }]);
    });
  });
});
