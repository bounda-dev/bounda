import { env } from "cloudflare:workers";
import { ConfigurationError } from "@bounda-dev/core";
import { memory } from "@bounda-dev/core/memory";
import { describe, expect, it } from "vitest";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { checkObjectJurisdiction, namespaceIn } from "../src/jurisdiction.ts";
import { boundaNamespace, tenantStub } from "../src/tenant-stub.ts";
import type { quietRegistry } from "./app.ts";
import { recordingStub } from "./recording-stub.ts";

const idIn = (jurisdiction: string | undefined) => ({ jurisdiction }) as DurableObjectId;

// A namespace of a runtime with jurisdictions, whose `jurisdiction(name)` hands out `within`.
const holding = (within: object) =>
  ({ jurisdiction: () => within }) as unknown as DurableObjectNamespace;

describe("namespaceIn", () => {
  it("narrows the namespace to the jurisdiction, and leaves it as it is without one", () => {
    const within = {};
    const asked: string[] = [];
    const namespace = {
      jurisdiction: (name: string) => {
        asked.push(name);
        return within;
      },
    } as unknown as DurableObjectNamespace;
    expect(namespaceIn(namespace, "eu")).toBe(within);
    expect(asked).toEqual(["eu"]);
    expect(namespaceIn(namespace, undefined)).toBe(namespace);
    expect(asked).toEqual(["eu"]);
  });

  it("keeps the namespace where workerd runs locally, which has no jurisdictions", () => {
    expect(namespaceIn(env.BARE, "eu")).toBe(env.BARE);
  });

  it("lets any other failure through", () => {
    const failing = {
      jurisdiction: () => {
        throw new TypeError("Unknown jurisdiction");
      },
    } as unknown as DurableObjectNamespace;
    expect(() => namespaceIn(failing, "eu")).toThrow("Unknown jurisdiction");
  });
});

describe("checkObjectJurisdiction", () => {
  it("lets an object start in the jurisdiction the configuration names", () => {
    expect(() =>
      checkObjectJurisdiction({ id: idIn("eu"), jurisdiction: "eu", namespace: undefined }),
    ).not.toThrow();
    expect(() =>
      checkObjectJurisdiction({
        id: idIn(undefined),
        jurisdiction: undefined,
        namespace: undefined,
      }),
    ).not.toThrow();
  });

  it("refuses an object created in another jurisdiction, or in one when the configuration names none", () => {
    const refusals = [
      [idIn("us"), "eu", "created in jurisdiction us, and cloudflare() names jurisdiction eu"],
      [idIn("eu"), undefined, "created in jurisdiction eu, and cloudflare() names no jurisdiction"],
      [idIn(undefined), "eu", "created in no jurisdiction, and cloudflare() names jurisdiction eu"],
    ] as const;
    for (const [id, jurisdiction, said] of refusals) {
      const check = () => checkObjectJurisdiction({ id, jurisdiction, namespace: holding({}) });
      expect(check).toThrow(ConfigurationError);
      expect(check).toThrow(
        `This Durable Object was ${said}: a tenant reached in two jurisdictions is two objects, each with part of its data. Reach the objects through tenantStub(), or through the namespace's jurisdiction() as cloudflare() names it`,
      );
    }
  });

  it("lets an object in no jurisdiction start where workerd has none, as its own namespace tells", () => {
    expect(() =>
      checkObjectJurisdiction({ id: idIn(undefined), jurisdiction: "eu", namespace: env.BARE }),
    ).not.toThrow();
    expect(() =>
      checkObjectJurisdiction({ id: idIn(undefined), jurisdiction: "eu", namespace: undefined }),
    ).toThrow("created in no jurisdiction");
    expect(() =>
      checkObjectJurisdiction({ id: idIn("us"), jurisdiction: "eu", namespace: env.BARE }),
    ).toThrow("created in jurisdiction us");
  });
});

describe("boundaNamespace", () => {
  it("is the namespace through the binding, narrowed to the jurisdiction cloudflare() names", () => {
    const within = {};
    const config = { storage: cloudflare({ binding: "SPY", jurisdiction: "eu" }) };
    expect(boundaNamespace({ config, env: { SPY: holding(within) } })).toBe(within);
    expect(boundaNamespace({ config: { storage: cloudflare() }, env })).toBe(env.STORE);
  });

  it("refuses a read model on cloudflare() in another jurisdiction than storage", () => {
    const config = {
      storage: cloudflare({ jurisdiction: "eu" }),
      readModels: { orders: cloudflare() },
    };
    expect(() => boundaNamespace({ config, env })).toThrow(
      "The read model orders lives in the tenant's Durable Object",
    );
  });
});

describe("tenantStub", () => {
  it("reaches the tenant's object by its name, through the binding cloudflare() names", async () => {
    const config = { storage: cloudflare() };
    const store = connect<typeof quietRegistry>(tenantStub({ config, env, tenant: "stubbed" }));
    await store.commands.placeOrder({ orderId: "o-1", total: 5, customer: "ada" });
    const same = connect<typeof quietRegistry>(env.STORE.get(env.STORE.idFromName("stubbed")));
    expect(await same.queries.getOrder({ orderId: "o-1" })).toMatchObject({ total: 5 });
  });

  it("reaches it in the jurisdiction cloudflare() names", () => {
    const { stub } = recordingStub();
    const named: string[] = [];
    const within = {
      idFromName: (name: string) => {
        named.push(name);
        return name;
      },
      get: () => stub,
    };
    const config = { storage: cloudflare({ binding: "SPY", jurisdiction: "eu" }) };
    expect(tenantStub({ config, env: { SPY: holding(within) }, tenant: "acme" })).toBe(stub);
    expect(named).toEqual(["acme"]);
  });

  it("refuses a Worker without the binding, or an app that does not run in a Durable Object", () => {
    expect(() =>
      tenantStub({ config: { storage: cloudflare({ binding: "MISSING" }) }, env, tenant: "a" }),
    ).toThrow(
      'The Worker has no binding "MISSING": bind the Bounda Durable Object under that name in wrangler.jsonc, or name its binding with cloudflare({ binding })',
    );
    expect(() => tenantStub({ config: { storage: memory() }, env, tenant: "a" })).toThrow(
      ConfigurationError,
    );
  });
});

describe("an object whose configuration names a jurisdiction", () => {
  it("starts where workerd runs locally, its own binding telling it has none", async () => {
    const config = { storage: cloudflare({ binding: "EU_STORE", jurisdiction: "eu" }) };
    const store = connect<typeof quietRegistry>(tenantStub({ config, env, tenant: "local" }));
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada" });
    expect(await store.queries.getOrder({ orderId: "o-1" })).toMatchObject({ total: 7 });
  });

  it("refuses to start outside it, with nothing to tell it workerd has none", async () => {
    const stub = env.UNBOUND_EU_STORE.get(env.UNBOUND_EU_STORE.idFromName("outside"));
    const store = connect<typeof quietRegistry>(stub);
    await expect(
      store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada" }),
    ).rejects.toThrow("created in no jurisdiction, and cloudflare() names jurisdiction eu");
  });
});
