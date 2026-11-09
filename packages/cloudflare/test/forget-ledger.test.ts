import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ConfigurationError, createApp, type PersonalDataForgottenPayload } from "@bounda-dev/core";
import { forgetLedgerContract } from "@bounda-dev/core/adapter/testing";
import { describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import { createKvForgetLedger, KV_LIST_DELAY_MS, kvForgetLedger } from "../src/forget-ledger.ts";
import { quietRegistry } from "./app.ts";
import { clock } from "./clock.ts";

let stores = 0;

describe("the forget ledger in Workers KV", () => {
  forgetLedgerContract({
    create: async () => {
      stores += 1;
      const store = stores;
      return async (tenant) =>
        createKvForgetLedger({
          namespace: env.FORGET_LEDGER,
          prefix: `contract-${store}/${tenant ?? ""}/`,
        });
    },
  });

  it("keeps each object's entries under its name, and shows them late", async () => {
    const ledgerOf = (tenant: string) =>
      kvForgetLedger({ binding: "FORGET_LEDGER" }).create({ env, tenant });
    const ada = await ledgerOf("named-ada");
    const bob = await ledgerOf("named-bob");
    const entry = {
      personId: "c-1",
      eventId: "e-1",
      forgottenAt: "2026-11-07T12:00:00.000Z",
      categories: ["marketing"],
    };
    await ada.append([entry]);
    expect(await ada.read({ limit: 10 })).toEqual([entry]);
    expect(await bob.read({ limit: 10 })).toEqual([]);
    expect(ada.visibilityDelayMs).toBe(KV_LIST_DELAY_MS);
  });

  it("fails the start of an object whose env lacks the binding, or binds something else", async () => {
    for (const LEDGER of [
      undefined,
      null,
      "a string",
      { list: () => undefined },
      { put: () => undefined },
    ]) {
      expect(() =>
        kvForgetLedger({ binding: "LEDGER" }).create({
          env: { ...env, LEDGER } as typeof env,
          tenant: "t",
        }),
      ).toThrow(
        new ConfigurationError(
          "runtime.personalData.forgetLedger.store names the KV binding LEDGER, which the Worker's env does not hold: add it under kv_namespaces in wrangler.jsonc",
        ),
      );
    }
  });
});

// A namespace that lists in pages as KV does, and counts the pages it listed.
const countingNamespace = () => {
  const keys = new Map<string, unknown>();
  const expirations = new Map<string, number | undefined>();
  let pages = 0;
  const namespace = {
    put: async (name: string, _value: string, options?: KVNamespacePutOptions) => {
      keys.set(name, options?.metadata ?? null);
      expirations.set(name, options?.expiration);
    },
    list: async ({ prefix, limit = 1_000, cursor }: KVNamespaceListOptions = {}) => {
      pages += 1;
      const names = [...keys.keys()].filter((name) => name.startsWith(prefix ?? "")).sort();
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const complete = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: keys.get(name) })),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(start + limit) }),
        cacheStatus: null,
      };
    },
  } as unknown as KVNamespace;
  return { namespace, keys, expirations, pages: () => pages };
};

const minute = (index: number): string =>
  new Date(Date.UTC(2026, 10, 7) + index * 60_000).toISOString();

describe("the KV forget ledger's listing", () => {
  it("lists every page when it reads from the first entry", async () => {
    const { namespace, pages } = countingNamespace();
    const ledger = createKvForgetLedger({ namespace, prefix: "p/" });
    const entries = Array.from({ length: 1_005 }, (_, index) => ({
      personId: `c-${index}`,
      eventId: `e-${String(index).padStart(4, "0")}`,
      forgottenAt: minute(index),
      categories: null,
    }));
    await ledger.append(entries);
    expect(await ledger.read({ limit: 2_000 })).toEqual(entries);
    expect(pages()).toBe(2);
  });

  it("stops listing at the first entry older than the one it reads after", async () => {
    const { namespace, pages } = countingNamespace();
    const ledger = createKvForgetLedger({ namespace, prefix: "p/" });
    const entries = Array.from({ length: 1_005 }, (_, index) => ({
      personId: `c-${index}`,
      eventId: `e-${String(index).padStart(4, "0")}`,
      forgottenAt: minute(index),
      categories: null,
    }));
    await ledger.append(entries);
    const after = entries[1_002] as (typeof entries)[number];
    expect(await ledger.read({ after, limit: 10 })).toEqual(entries.slice(1_003));
    expect(pages()).toBe(1);
  });

  it("expires each entry keepFor after its forgetting, and writes none already past it", async () => {
    const { namespace, keys, expirations } = countingNamespace();
    const keepForMs = 3_600_000;
    const ledger = await kvForgetLedger({ binding: "LEDGER" }).create({
      env: { ...env, LEDGER: namespace } as typeof env,
      tenant: "t",
      keepForMs,
    });
    const now = Date.now();
    const at = (milliseconds: number): string => new Date(now + milliseconds).toISOString();
    await ledger.append([
      { personId: "c-1", eventId: "e-1", forgottenAt: at(-keepForMs - 1_000), categories: null },
      { personId: "c-2", eventId: "e-2", forgottenAt: at(-keepForMs + 30_000), categories: null },
      { personId: "c-3", eventId: "e-3", forgottenAt: at(0), categories: null },
    ]);
    expect(
      [...keys.values()].map((metadata) => (metadata as { personId: string }).personId),
    ).toEqual(["c-2", "c-3"]);
    const [soon, later] = [...expirations.values()] as [number, number];
    // KV expires a key a minute from now at the soonest.
    expect(soon).toBeGreaterThanOrEqual(Math.floor(now / 1000) + 60);
    expect(soon).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60);
    expect(later).toBe(Math.ceil((Date.parse(at(0)) + keepForMs) / 1000));
    const forever = countingNamespace();
    await createKvForgetLedger({ namespace: forever.namespace, prefix: "p/" }).append([
      { personId: "c-1", eventId: "e-1", forgottenAt: at(-keepForMs * 1_000), categories: null },
    ]);
    expect([...forever.expirations.values()]).toEqual([undefined]);
  });

  it("skips a key without the entry's metadata", async () => {
    const { namespace, keys } = countingNamespace();
    const ledger = createKvForgetLedger({ namespace, prefix: "p/" });
    keys.set("p/1:e-stray", null);
    expect(await ledger.read({ limit: 10 })).toEqual([]);
  });

  it("refuses an object without a name, whose entries it could not keep apart", async () => {
    const { namespace } = countingNamespace();
    expect(() =>
      kvForgetLedger({ binding: "LEDGER" }).create({
        env: { ...env, LEDGER: namespace } as typeof env,
      }),
    ).toThrow(
      new ConfigurationError(
        "A KV forget ledger keeps each object's entries under its name, and this object has none: reach it through idFromName",
      ),
    );
  });

  it("keeps an object's entries under its name", async () => {
    const { namespace, keys } = countingNamespace();
    const ledger = await kvForgetLedger({ binding: "LEDGER" }).create({
      env: { ...env, LEDGER: namespace } as typeof env,
      tenant: "acme/eu",
    });
    await ledger.append([
      { personId: "c-1", eventId: "e-1", forgottenAt: minute(0), categories: null },
    ]);
    expect([...keys.keys()]).toEqual([
      `bounda/forget-ledger/acme%2Feu/${8_640_000_000_000_000 - Date.parse(minute(0))}:e-1`,
    ]);
    expect([...keys.values()]).toEqual([{ personId: "c-1", forgottenAt: minute(0) }]);
  });
});

const config = {
  storage: cloudflare(),
  runtime: {
    personalData: { forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) } },
  },
};

// Workerd keeps no point-in-time history of an object's storage, so a backup is a copy of every
// table the app keeps, and restoring it puts their rows back.
const copyTables = (storage: DurableObjectStorage, restore: boolean): void => {
  const tables = storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bounda_%'",
    )
    .toArray()
    .map(({ name }) => name);
  for (const table of tables) {
    if (restore) {
      storage.sql.exec(`DELETE FROM "${table}"`);
      storage.sql.exec(`INSERT INTO "${table}" SELECT * FROM "backup_${table}"`);
    } else {
      storage.sql.exec(`CREATE TABLE "backup_${table}" AS SELECT * FROM "${table}"`);
    }
  }
};

describe("restoring a Durable Object's storage with a forget ledger", () => {
  it("forgets again at the next start whoever was forgotten after the copy was taken", async () => {
    const stub = env.LEDGER_STORE.get(env.LEDGER_STORE.idFromName("restored-tenant"));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    await store.commands.placeOrder({ orderId: "o-2", total: 9, customer: "bob", note: "door" });
    // A copy of an object that ran its alarm, so the walk over what came before the marks is in it.
    await runInDurableObject(stub, (instance) => instance.alarm());
    await runInDurableObject(stub, (_instance, state) => copyTables(state.storage, false));
    await store.forget("ada");
    await runInDurableObject(stub, (instance) => instance.alarm());
    await runInDurableObject(stub, (_instance, state) => copyTables(state.storage, true));

    // What the object's constructor runs when it starts again.
    const outcome = await runInDurableObject(stub, async (_instance, state) => {
      const app = await createApp({
        registry: quietRegistry,
        config: configForObject(config, state.storage),
        env,
        tenant: "restored-tenant",
        clock,
      });
      try {
        const forgotten = (await app.events.read({ limit: 100 }))
          .filter((event) => event.type === "PersonalDataForgotten")
          .map((event) => (event.payload as PersonalDataForgottenPayload).reason);
        return {
          forgotten,
          ada: (await app.exportPersonalData("ada")).events[0]?.data,
          bob: (await app.exportPersonalData("bob")).events[0]?.data,
          lag: (await app.getLag()).forgetLedger,
          nextDueAt: (await app.nextDueAt())?.getTime(),
          now: clock.now().getTime(),
        };
      } finally {
        await app.stop();
      }
    });
    expect(outcome).toMatchObject({
      forgotten: ["restored"],
      ada: { note: null },
      bob: { note: "door" },
      lag: { reconciled: true },
    });
    expect(outcome.nextDueAt).toBe(outcome.now + KV_LIST_DELAY_MS);
  });
});
