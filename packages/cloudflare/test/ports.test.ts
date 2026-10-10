import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp } from "@bounda-dev/core";
import { beforeEach, describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { regionLog, regionRegistry } from "./app.ts";

beforeEach(() => {
  regionLog.length = 0;
});

describe("an implementation built by create inside a Durable Object", () => {
  it("receives the object's env, once, and serves every command", async () => {
    const store = connect<typeof regionRegistry>(
      env.REGION_STORE.get(env.REGION_STORE.newUniqueId()),
    );
    await store.commands.placeOrder({ orderId: "o-1", total: 1, customer: "ada" });
    await store.commands.placeOrder({ orderId: "o-2", total: 2, customer: "ada" });
    expect(regionLog).toEqual(["eu-test:o-1", "eu-test:o-2"]);
  });

  it("is closed through Symbol.asyncDispose when the app stops", async () => {
    const stub = env.BARE.get(env.BARE.newUniqueId());
    await runInDurableObject(stub, async (_instance, state) => {
      const app = await createApp({
        registry: regionRegistry,
        config: configForObject({ storage: cloudflare() }, state.storage),
        env,
      });
      await app.commands.placeOrder({ orderId: "o-1", total: 1, customer: "ada" });
      await app.stop();
    });
    expect(regionLog).toEqual(["eu-test:o-1", "closed"]);
  });
});
