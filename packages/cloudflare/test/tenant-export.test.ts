import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { tenantExportContract } from "@bounda-dev/core/adapter/testing";
import { describe } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { insideObject } from "./inside-object.ts";

describe("handing a tenant back from a Durable Object's storage", () => {
  tenantExportContract({
    create: async () => {
      const stub = env.BARE.get(env.BARE.newUniqueId());
      return insideObject(
        stub,
        await runInDurableObject(stub, (_instance, state) =>
          durableObjectAdapter({ storage: state.storage, options: {} }),
        ),
      );
    },
  });
});
