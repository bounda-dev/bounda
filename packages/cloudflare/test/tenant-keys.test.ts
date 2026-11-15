import { env } from "cloudflare:workers";
import { ConfigurationError } from "@bounda-dev/core";
import { tenantKeyStoreContract } from "@bounda-dev/core/adapter/testing";
import { describe, expect, it } from "vitest";
import { createKvTenantKeyStore, KV_TENANT_KEYS_ROOT, kvTenantKeys } from "../src/tenant-keys.ts";

let stores = 0;

describe("the tenant key store in Workers KV", () => {
  tenantKeyStoreContract({
    create: async () => {
      stores += 1;
      return createKvTenantKeyStore({ namespace: env.TENANT_KEYS, prefix: `contract-${stores}/` });
    },
    compareAndSet: false,
  });

  it("keeps each tenant's record under the root and its name, as JSON with its revision", async () => {
    const store = await kvTenantKeys({ binding: "TENANT_KEYS" }).create({ env });
    const record = {
      store: "s-1",
      keys: [
        {
          kid: "t-1",
          fingerprint: "fp",
          key: "wrapped",
          wrappedBy: "m-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      forgotten: null,
    };
    expect(await store.put("tenant a", record, null)).toBe(true);
    expect(await env.TENANT_KEYS.get(`${KV_TENANT_KEYS_ROOT}tenant%20a`, "json")).toEqual({
      revision: 1,
      record: JSON.stringify(record),
    });
    expect(await store.get("tenant a")).toEqual({ ...record, revision: 1 });
    const apart = await kvTenantKeys({ binding: "TENANT_KEYS", prefix: "other/" }).create({ env });
    expect(await apart.get("tenant a")).toBeNull();
  });

  it("lets one of two writes over the same revision win, as two requests to one object make them", async () => {
    const store = createKvTenantKeyStore({ namespace: env.TENANT_KEYS, prefix: "racing/" });
    const record = { store: "s-1", keys: [], forgotten: null };
    await store.put("acme", record, null);
    const won = await Promise.all([
      store.put("acme", { ...record, store: "s-2" }, 1),
      store.put("acme", { ...record, store: "s-3" }, 1),
    ]);
    expect(won).toEqual([true, false]);
    expect(await store.get("acme")).toEqual({ ...record, store: "s-2", revision: 2 });
  });

  it("refuses a binding the Worker does not have, and a record it cannot read", async () => {
    await expect(
      Promise.resolve().then(() => kvTenantKeys({ binding: "MISSING" }).create({ env })),
    ).rejects.toThrow(
      new ConfigurationError(
        "runtime.personalData.tenantKeys names the KV binding MISSING, which the Worker's env does not hold: add it under kv_namespaces in wrangler.jsonc",
      ),
    );
    for (const held of [null, { put: () => undefined }, { get: () => undefined }]) {
      await expect(
        Promise.resolve().then(() =>
          kvTenantKeys({ binding: "HELD" }).create({ env: { HELD: held } as never }),
        ),
      ).rejects.toThrow(ConfigurationError);
    }
    for (const binding of ["STORE_REGION", "STORE"]) {
      await expect(
        Promise.resolve().then(() => kvTenantKeys({ binding }).create({ env })),
      ).rejects.toThrow(`names the KV binding ${binding}, which the Worker's env does not hold`);
    }
    const broken = createKvTenantKeyStore({ namespace: env.TENANT_KEYS, prefix: "broken/" });
    for (const [tenant, stored] of [
      ["text", "a record"],
      ["revision", { revision: "1", record: "{}" }],
      ["record", { revision: 1, record: {} }],
      ["no-record", { revision: 1 }],
      ["no-revision", { record: "{}" }],
    ] as const) {
      await env.TENANT_KEYS.put(`broken/${tenant}`, JSON.stringify(stored));
      await expect(broken.get(tenant)).rejects.toThrow(
        `The KV tenant key store holds no record for ${tenant}'s key`,
      );
    }
  });
});
