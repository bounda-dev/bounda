import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { subscriberFailureRetentionContract } from "@bounda-dev/core/adapter/testing";
import { describe } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { insideObject } from "./inside-object.ts";

describe("the retention of subscriber failures in a Durable Object's storage", () => {
  subscriberFailureRetentionContract({
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
