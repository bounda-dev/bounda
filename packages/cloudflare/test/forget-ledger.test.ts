import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ConfigurationError,
  createApp,
  FORGET_LEDGER_GRACE_MS,
  ForgetLedgerUnavailableError,
  type PersonalDataForgottenPayload,
} from "@bounda-dev/core";
import type { Adapter } from "@bounda-dev/core/adapter";
import { forgetLedgerContract } from "@bounda-dev/core/adapter/testing";
import { describe, expect, it } from "vitest";
import { durableObjectAdapter } from "../src/adapter.ts";
import { configForObject } from "../src/bounda-object.ts";
import { connect } from "../src/client.ts";
import { cloudflare } from "../src/definition.ts";
import {
  createKvForgetLedger,
  expireKvForgetLedger,
  KV_FORGET_LEDGER_ROOT,
  KV_LIST_DELAY_MS,
  kvForgetLedger,
  planKvForgetLedgerExpiry,
} from "../src/forget-ledger.ts";
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
      reason: "requested" as const,
      fingerprints: ["k-1"],
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
      reason: "requested" as const,
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
      reason: "requested" as const,
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
      {
        personId: "c-1",
        eventId: "e-1",
        forgottenAt: at(-keepForMs - 1_000),
        categories: null,
        reason: "requested",
      },
      {
        personId: "c-2",
        eventId: "e-2",
        forgottenAt: at(-keepForMs + 30_000),
        categories: null,
        reason: "requested",
      },
      {
        personId: "c-3",
        eventId: "e-3",
        forgottenAt: at(0),
        categories: null,
        reason: "requested",
      },
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
      {
        personId: "c-1",
        eventId: "e-1",
        forgottenAt: at(-keepForMs * 1_000),
        categories: null,
        reason: "requested",
      },
    ]);
    expect([...forever.expirations.values()]).toEqual([undefined]);
  });

  it("skips a key without the entry's metadata", async () => {
    const { namespace, keys } = countingNamespace();
    const ledger = createKvForgetLedger({ namespace, prefix: "p/" });
    keys.set("p/1:e-stray", null);
    expect(await ledger.read({ limit: 10 })).toEqual([]);
  });

  it("keeps an entry's keys in its value when they do not fit KV's metadata beside its categories", async () => {
    const namespace = env.FORGET_LEDGER;
    const ledger = createKvForgetLedger({ namespace, prefix: "overflow/" });
    const entry = (eventId: string, pad: string) => ({
      personId: "c-1",
      categories: ["marketing", "invoices"],
      eventId,
      forgottenAt: minute(0),
      reason: "requested" as const,
      fingerprints: ["k-1", pad],
    });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const { eventId: _, ...unpadded } = entry("e-0", "");
    const pad = "x".repeat(1_024 - bytes(unpadded));
    await ledger.append([entry("e-1", pad), entry("e-2", `${pad}x`)]);
    const { keys } = await namespace.list({ prefix: "overflow/" });
    expect(
      keys.map(({ metadata }) => [bytes(metadata), Reflect.get(Object(metadata), "keysInValue")]),
    ).toEqual([
      [1_024, undefined],
      [
        1_024 - bytes(["k-1", pad]) - `,"fingerprints":`.length + `,"keysInValue":true`.length,
        true,
      ],
    ]);
    expect(await namespace.get(keys[1]?.name ?? "")).toBe(JSON.stringify(["k-1", `${pad}x`]));
    expect(await ledger.read({ limit: 10 })).toEqual([entry("e-1", pad), entry("e-2", `${pad}x`)]);
  });

  it("reads an entry whose value lost its keys as one that names none", async () => {
    const { namespace, keys } = countingNamespace();
    const values = new Map([
      ["p/1:e-1", "not json"],
      ["p/2:e-2", JSON.stringify([1])],
    ]);
    const reading = {
      ...namespace,
      list: namespace.list,
      get: async (name: string) => values.get(name) ?? null,
    } as unknown as KVNamespace;
    const ledger = createKvForgetLedger({ namespace: reading, prefix: "p/" });
    for (const at of ["1:e-1", "2:e-2", "3:e-3"]) {
      keys.set(`p/${at}`, { personId: "c-1", forgottenAt: minute(0), keysInValue: true });
    }
    const read = await ledger.read({ limit: 10 });
    expect(read).toHaveLength(3);
    for (const entry of read) expect(entry).not.toHaveProperty("fingerprints");
  });

  it("reads a key written before entries kept their reason and keys as a request naming none", async () => {
    const { namespace, keys } = countingNamespace();
    const ledger = createKvForgetLedger({ namespace, prefix: "p/" });
    keys.set("p/1:e-1", { personId: "c-1", forgottenAt: minute(0) });
    keys.set("p/2:e-2", { personId: "c-2", forgottenAt: minute(0), reason: "retention" });
    const read = await ledger.read({ limit: 10 });
    expect(read).toEqual([
      {
        personId: "c-1",
        categories: null,
        eventId: "e-1",
        forgottenAt: minute(0),
        reason: "requested",
      },
      {
        personId: "c-2",
        categories: null,
        eventId: "e-2",
        forgottenAt: minute(0),
        reason: "retention",
      },
    ]);
    expect(read[0]).not.toHaveProperty("fingerprints");
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
      {
        personId: "c-1",
        eventId: "e-1",
        forgottenAt: minute(0),
        categories: null,
        reason: "retention",
        fingerprints: ["k-1"],
      },
      {
        personId: "c-2",
        eventId: "e-2",
        forgottenAt: minute(0),
        categories: null,
        reason: "requested",
      },
    ]);
    expect([...keys.keys()]).toEqual([
      `${KV_FORGET_LEDGER_ROOT}acme%2Feu/${8_640_000_000_000_000 - Date.parse(minute(0))}:e-1`,
      `${KV_FORGET_LEDGER_ROOT}acme%2Feu/${8_640_000_000_000_000 - Date.parse(minute(0))}:e-2`,
    ]);
    expect([...keys.values()]).toEqual([
      { personId: "c-1", forgottenAt: minute(0), reason: "retention", fingerprints: ["k-1"] },
      { personId: "c-2", forgottenAt: minute(0), reason: "requested" },
    ]);
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
    clock.advance(FORGET_LEDGER_GRACE_MS);

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
      forgotten: ["requested"],
      ada: { note: null },
      bob: { note: "door" },
      lag: { reconciled: true },
    });
    expect(outcome.nextDueAt).toBe(outcome.now + KV_LIST_DELAY_MS);
  });
});

describe("expiring a KV forget ledger", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 10, 9);
  const at = (daysAgo: number) => ({
    personId: "c-1",
    forgottenAt: new Date(NOW - daysAgo * DAY).toISOString(),
  });

  it("plans an expiration for every entry kept for good or longer than keepFor, and the removal of those past it", () => {
    // A second short of keepFor: KV expires a key a minute from now at the soonest.
    const soonest = { ...at(0), forgottenAt: new Date(NOW - 35 * DAY + 1_000).toISOString() };
    expect(
      planKvForgetLedgerExpiry({
        keys: [
          { name: "kept", metadata: at(1) },
          { name: "past", metadata: at(36) },
          { name: "just-past", metadata: at(35) },
          { name: "longer", metadata: at(2), expiration: NOW / 1000 + 100 * 86_400 },
          { name: "sooner", metadata: at(2), expiration: NOW / 1000 + 86_400 },
          { name: "due", metadata: at(2), expiration: (NOW + 33 * DAY) / 1000 },
          { name: "soonest", metadata: soonest },
          { name: "valued", metadata: { ...at(1), keysInValue: true } },
          { name: "stray" },
          { name: "empty", metadata: null },
          { name: "unreadable", metadata: { forgottenAt: "not a time" } },
          { name: "untimed", metadata: { forgottenAt: 3 } },
          { name: "text", metadata: "kept" },
        ],
        keepForMs: 35 * DAY,
        now: NOW,
      }),
    ).toEqual({
      expire: [
        { key: "kept", value: "", expiration: (NOW + 34 * DAY) / 1000, metadata: at(1) },
        { key: "longer", value: "", expiration: (NOW + 33 * DAY) / 1000, metadata: at(2) },
        {
          key: "soonest",
          value: "",
          expiration: NOW / 1000 + 60,
          metadata: soonest,
        },
        {
          key: "valued",
          value: null,
          expiration: (NOW + 34 * DAY) / 1000,
          metadata: { ...at(1), keysInValue: true },
        },
      ],
      remove: ["past", "just-past"],
    });
  });

  it("writes the plan to the namespace, every object's entries and nothing else", async () => {
    const namespace = env.FORGET_LEDGER;
    const now = Date.now();
    const written = (daysAgo: number) => ({
      personId: "c-1",
      forgottenAt: new Date(now - daysAgo * DAY).toISOString(),
      reason: "requested",
    });
    await namespace.put(`${KV_FORGET_LEDGER_ROOT}expire-a/1:e-1`, "", { metadata: written(1) });
    await namespace.put(`${KV_FORGET_LEDGER_ROOT}expire-b/2:e-2`, "", { metadata: written(40) });
    await namespace.put("expire-elsewhere", "kept", { metadata: written(1) });
    const valued = `${KV_FORGET_LEDGER_ROOT}expire-c/3:e-3`;
    await namespace.put(valued, `["k-1"]`, { metadata: { ...written(1), keysInValue: true } });
    const expiry = await expireKvForgetLedger({ namespace, keepForMs: 35 * DAY, now });
    expect(await namespace.get(valued)).toBe(`["k-1"]`);
    expect(expiry.expire.map(({ key }) => key)).toContain(`${KV_FORGET_LEDGER_ROOT}expire-a/1:e-1`);
    expect(expiry.remove).toContain(`${KV_FORGET_LEDGER_ROOT}expire-b/2:e-2`);
    const listed = await namespace.list({ prefix: KV_FORGET_LEDGER_ROOT });
    expect(listed.keys.find(({ name }) => name.endsWith("expire-a/1:e-1"))).toMatchObject({
      expiration: Math.ceil((now + 34 * DAY) / 1000),
      metadata: written(1),
    });
    expect(listed.keys.some(({ name }) => name.endsWith("expire-b/2:e-2"))).toBe(false);
    expect((await namespace.list({ prefix: "expire-elsewhere" })).keys).toEqual([
      { name: "expire-elsewhere", metadata: written(1) },
    ]);
    expect(await expireKvForgetLedger({ namespace, keepForMs: 35 * DAY })).toMatchObject({
      remove: [],
    });
  });

  it("leaves alone a key whose value held its keys once it is gone", async () => {
    const { namespace, keys, expirations } = countingNamespace();
    const gone = `${KV_FORGET_LEDGER_ROOT}t/1:e-1`;
    keys.set(gone, { ...at(1), keysInValue: true });
    const reading = { ...namespace, get: async () => null } as unknown as KVNamespace;
    const expiry = await expireKvForgetLedger({
      namespace: reading,
      keepForMs: 35 * DAY,
      now: NOW,
    });
    expect(expiry.expire.map(({ key }) => key)).toEqual([gone]);
    expect(expirations.get(gone)).toBeUndefined();
  });

  it("lists every page of a namespace with more keys than a page", async () => {
    const { namespace, keys, pages } = countingNamespace();
    for (let index = 0; index < 1_001; index += 1) {
      keys.set(`${KV_FORGET_LEDGER_ROOT}t/${index}:e-${index}`, at(0));
    }
    const expiry = await expireKvForgetLedger({ namespace, keepForMs: DAY, now: NOW });
    expect(expiry.expire).toHaveLength(1_001);
    expect(pages()).toBe(2);
  });
});

describe("a Durable Object's forgetting and the KV ledger", () => {
  it("records the intention in KV before it commits, and the next start commits one whose commit never happened", async () => {
    const stub = env.LEDGER_STORE.get(env.LEDGER_STORE.idFromName("intended-tenant"));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    const intention = await runInDurableObject(stub, async (_instance, state) => {
      const opened = durableObjectAdapter({ storage: state.storage, options: {} });
      const evicted: Adapter = {
        ...opened,
        createStorage: async () => {
          const storage = await opened.createStorage();
          return {
            ...storage,
            transact: () => Promise.reject(new Error("the object was evicted")),
          };
        },
      };
      const app = await createApp({
        registry: quietRegistry,
        config: { ...configForObject(config, state.storage), storage: evicted },
        env,
        tenant: "intended-tenant",
        clock,
      });
      try {
        await expect(app.forget("ada")).rejects.toThrow("the object was evicted");
      } finally {
        await app.stop();
      }
      const ledger = await kvForgetLedger({ binding: "FORGET_LEDGER" }).create({
        env,
        tenant: "intended-tenant",
      });
      const [entry] = await ledger.read({ limit: 10 });
      return entry;
    });
    expect(intention).toMatchObject({
      personId: "ada",
      reason: "requested",
      fingerprints: [expect.any(String)],
    });
    clock.advance(FORGET_LEDGER_GRACE_MS);
    const outcome = await runInDurableObject(stub, async (_instance, state) => {
      const app = await createApp({
        registry: quietRegistry,
        config: configForObject(config, state.storage),
        env,
        tenant: "intended-tenant",
        clock,
      });
      try {
        return {
          forgotten: (await app.events.read({ limit: 100 }))
            .filter((event) => event.type === "PersonalDataForgotten")
            .map((event) => event.id),
          ada: (await app.exportPersonalData("ada")).events[0]?.data,
        };
      } finally {
        await app.stop();
      }
    });
    expect(outcome).toEqual({
      forgotten: [intention?.eventId],
      ada: expect.objectContaining({ note: null }),
    });
  });

  it("forgets nobody, when strict, while KV does not take the intention", async () => {
    const stub = env.LEDGER_STORE.get(env.LEDGER_STORE.idFromName("strict-tenant"));
    const store = connect<typeof quietRegistry>(stub);
    await store.commands.placeOrder({ orderId: "o-1", total: 7, customer: "ada", note: "bell" });
    const refusal = await runInDurableObject(stub, async (_instance, state) => {
      const down = {
        list: (options?: KVNamespaceListOptions) => env.FORGET_LEDGER.list(options),
        put: () => Promise.reject(new Error("KV is down")),
      };
      const app = await createApp({
        registry: quietRegistry,
        config: {
          ...configForObject(config, state.storage),
          runtime: {
            personalData: {
              forgetLedger: { store: kvForgetLedger({ binding: "DOWN" }), strict: true },
            },
          },
        },
        env: { ...env, DOWN: down } as typeof env,
        tenant: "strict-tenant",
        clock,
      });
      try {
        const error = await app.forget("ada").catch((thrown: unknown) => thrown);
        return {
          unavailable: error instanceof ForgetLedgerUnavailableError,
          code: (error as { code?: string }).code,
          ada: (await app.exportPersonalData("ada")).events[0]?.data,
        };
      } finally {
        await app.stop();
      }
    });
    expect(refusal).toEqual({
      unavailable: true,
      code: "FORGET_LEDGER_UNAVAILABLE",
      ada: expect.objectContaining({ note: "bell" }),
    });
  });
});
