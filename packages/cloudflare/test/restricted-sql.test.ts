import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULT_TABLE_PREFIX, tableNameFor } from "@bounda-dev/core/adapter/sql";
import { restrictedSqlContract } from "@bounda-dev/core/adapter/testing";
import { describe } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { insideObject } from "./inside-object.ts";

describe("hand-written SQL under restriction in a Durable Object's storage", () => {
  restrictedSqlContract({
    create: async () => {
      const stub = env.BARE.get(env.BARE.newUniqueId());
      return {
        storage: insideObject(
          stub,
          await runInDurableObject(stub, (_instance, state) =>
            durableObjectAdapter({ storage: state.storage, options: {} }),
          ),
        ),
        table: (readModel) => tableNameFor({ prefix: DEFAULT_TABLE_PREFIX, readModel }),
        // The driver answers only calls made from the object's own context, as its stores do.
        raw: (driver, sql) =>
          runInDurableObject(stub, () => (driver as SqlStorage).exec(sql).toArray()),
      };
    },
  });
});
