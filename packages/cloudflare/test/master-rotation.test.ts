import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { defineTenantKeyStore, masterKey } from "@bounda-dev/core/config";
import { describe, expect, it, vi } from "vitest";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { createKvTenantKeyStore, KV_TENANT_KEYS_ROOT } from "../src/tenant-keys.ts";
import { createWorker } from "../src/worker.ts";
import type { quietRegistry } from "./app.ts";
import worker from "./test-worker.ts";

interface Stored {
  readonly revision: number;
  readonly record: string;
}

// Puts every version of the tenant's key under `wrappedBy`, as a rotation of the master key
// leaves it until rewrapped.
const wrappedUnder = async (tenant: string, wrappedBy: string): Promise<void> => {
  const key = `${KV_TENANT_KEYS_ROOT}${encodeURIComponent(tenant)}`;
  const stored = (await env.TENANT_KEYS.get(key, "json")) as Stored;
  const record = JSON.parse(stored.record) as { keys: { wrappedBy: string }[] };
  const keys = record.keys.map((version) => ({ ...version, wrappedBy }));
  await env.TENANT_KEYS.put(
    key,
    JSON.stringify({ ...stored, record: JSON.stringify({ ...record, keys }) }),
  );
};

describe("a rotation of the master key on Cloudflare", () => {
  it("wakes, on the Worker's schedule, every object whose tenant's key is still under a previous master key", async () => {
    const tenant = "rewrap-asleep";
    const stub = env.STORE.get(env.STORE.idFromName(tenant));
    await connect<typeof quietRegistry>(stub).commands.placeOrder({
      orderId: "o-1",
      total: 1,
      customer: "ada",
    });
    const asleep = async () =>
      runInDurableObject(stub as unknown as DurableObjectStub, async (_object, state) => {
        await state.storage.deleteAlarm();
      });
    const alarm = () =>
      runInDurableObject(stub as unknown as DurableObjectStub, (_object, state) =>
        state.storage.getAlarm(),
      );
    await asleep();
    await worker.scheduled?.({} as ScheduledController, env, createExecutionContext());
    expect(await alarm()).toBeNull();

    await wrappedUnder(tenant, "previous-master");
    const before = Date.now();
    await worker.scheduled?.({} as ScheduledController, env, createExecutionContext());
    const armed = await alarm();
    expect(armed).toBeGreaterThanOrEqual(before);
    expect(armed).toBeLessThanOrEqual(Date.now());
  });

  it("reaches an object reached through an id without a name, its tenant the id", async () => {
    const id = env.STORE.newUniqueId();
    const stub = env.STORE.get(id);
    await connect<typeof quietRegistry>(stub).commands.placeOrder({
      orderId: "o-1",
      total: 1,
      customer: "ada",
    });
    await runInDurableObject(stub as unknown as DurableObjectStub, (_object, state) =>
      state.storage.deleteAlarm(),
    );
    await wrappedUnder(id.toString(), "previous-master");
    await worker.scheduled?.({} as ScheduledController, env, createExecutionContext());
    expect(
      await runInDurableObject(stub as unknown as DurableObjectStub, (_object, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
  });

  it("wakes the rest when one object fails to, and an object named like an id by its name", async () => {
    const named = "a".repeat(64);
    const stub = env.STORE.get(env.STORE.idFromName(named));
    await connect<typeof quietRegistry>(stub).commands.placeOrder({
      orderId: "o-1",
      total: 1,
      customer: "ada",
    });
    await runInDurableObject(stub as unknown as DurableObjectStub, (_object, state) =>
      state.storage.deleteAlarm(),
    );
    await wrappedUnder(named, "previous-master");
    // A record whose object refuses to start: it belongs to another database.
    const key = (tenant: string) => `${KV_TENANT_KEYS_ROOT}${encodeURIComponent(tenant)}`;
    const copied = (await env.TENANT_KEYS.get(key(named), "json")) as Stored;
    const record = JSON.parse(copied.record) as { store: string };
    await env.TENANT_KEYS.put(
      key("0-intruder"),
      JSON.stringify({ ...copied, record: JSON.stringify({ ...record, store: "elsewhere" }) }),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let lines: unknown[][] = [];
    try {
      await worker.scheduled?.({} as ScheduledController, env, createExecutionContext());
      lines = [...logged.mock.calls];
    } finally {
      logged.mockRestore();
    }
    expect(
      await runInDurableObject(stub as unknown as DurableObjectStub, (_object, state) =>
        state.storage.getAlarm(),
      ),
    ).not.toBeNull();
    const woken = lines
      .map(([line]) => JSON.parse(String(line)) as { message: string; tenant?: string })
      .filter(({ message }) => message === "bounda worker could not wake a tenant's object");
    expect(woken.map(({ tenant }) => tenant)).toEqual(["0-intruder"]);
    await env.TENANT_KEYS.delete(key("0-intruder"));
  });

  it("wakes them in the jurisdiction the config names", async () => {
    const tenant = "rewrap-in-eu";
    await connect<typeof quietRegistry>(
      env.STORE.get(env.STORE.idFromName(tenant)),
    ).commands.placeOrder({
      orderId: "o-1",
      total: 1,
      customer: "ada",
    });
    await wrappedUnder(tenant, "previous-master");
    const woken: string[] = [];
    const inEu = {
      idFromName: (name: string) => {
        woken.push(name);
        return name;
      },
      get: () => ({ wake: async () => ({ ok: true, value: undefined }) }),
    };
    const elsewhere = () => {
      throw new Error("reached outside the jurisdiction");
    };
    const spy = {
      idFromName: elsewhere,
      jurisdiction: (name: string) => (name === "eu" ? inEu : elsewhere()),
    };
    const euWorker = createWorker({
      config: {
        storage: cloudflare({ binding: "SPY", jurisdiction: "eu" }),
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            // The records `STORE` keeps in KV, which a store of the EU would hold.
            tenantKeys: defineTenantKeyStore(
              ({ env: bound }) =>
                createKvTenantKeyStore({
                  namespace: (bound as Cloudflare.Env).TENANT_KEYS,
                  prefix: KV_TENANT_KEYS_ROOT,
                }),
              { location: "jurisdiction eu" },
            ),
          },
        },
      },
      tenantOf: () => "default",
    });
    await euWorker.scheduled?.(
      {} as ScheduledController,
      Object.assign(Object.create(env) as object, { SPY: spy }) as unknown as Cloudflare.Env,
      createExecutionContext(),
    );
    expect(woken).toContain(tenant);
  });
});
