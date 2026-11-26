import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createApp, createFixedClock } from "@bounda-dev/core";
import { masterKey } from "@bounda-dev/core/config";
import { describe, expect, it } from "vitest";
import { configForObject } from "../src/bounda-object.ts";
import { cloudflare } from "../src/definition.ts";
import { KV_LIST_DELAY_MS, kvForgetLedger } from "../src/forget-ledger.ts";
import { kvTenantKeys } from "../src/tenant-keys.ts";
import { quietRegistry } from "./app.ts";

const MARKS = "bounda/forget-ledger-marks/";
// How often the app moves the generation while it writes, and the marks with it.
const STEP_MS = 5_000;

interface Listed {
  readonly mark: string;
  readonly at: number;
  readonly keys: number;
}

// The namespace the ledger writes to, recording when each mark's key was written and how many
// keys each listing of a mark read.
const recording = (namespace: KVNamespace, now: () => number) => {
  const raised: { readonly mark: string; readonly at: number }[] = [];
  const listed: Listed[] = [];
  const markOf = (key: string): string | null => {
    if (!key.startsWith(MARKS)) return null;
    // `<ledger's prefix><mark>/<value>/<time>`
    const [mark] = key.slice(MARKS.length).split("/").slice(-3);
    return mark ?? null;
  };
  const recorded = {
    get: namespace.get.bind(namespace),
    delete: namespace.delete.bind(namespace),
    put: async (key: string, value: string, options?: KVNamespacePutOptions) => {
      const mark = markOf(key);
      if (mark !== null) raised.push({ mark, at: now() });
      return namespace.put(key, value, options);
    },
    list: async (options?: KVNamespaceListOptions) => {
      const page = await namespace.list(options);
      const prefix = options?.prefix ?? "";
      if (prefix.startsWith(MARKS)) {
        listed.push({ mark: prefix.split("/").at(-2) ?? "", at: now(), keys: page.keys.length });
      }
      return page;
    },
  } as unknown as KVNamespace;
  return { namespace: recorded, raised, listed };
};

interface RunArgs {
  readonly tenant: string;
  readonly minutes: number;
  // How long each instance lives before the object restarts, `null` for one that never does.
  readonly restartEveryMs: number | null;
}

// An object that writes every step, as a busy one does, its instances started over as often as
// asked: what the marks hold and what reading them costs, as the runtime raises and prunes them.
const run = ({ tenant, minutes, restartEveryMs }: RunArgs) => {
  const stub = env.BARE.get(env.BARE.idFromName(tenant));
  return runInDurableObject(stub, async (_instance, state) => {
    const clock = createFixedClock(new Date(Date.UTC(2026, 10, 26)));
    const ledger = recording(env.FORGET_LEDGER, () => clock.now().getTime());
    const config = configForObject(
      {
        storage: cloudflare(),
        runtime: {
          personalData: {
            keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
            tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
            forgetLedger: { store: kvForgetLedger({ binding: "MARKED_LEDGER" }) },
          },
        },
      },
      state.storage,
    );
    const open = () =>
      createApp({
        registry: quietRegistry,
        config,
        env: { ...env, MARKED_LEDGER: ledger.namespace } as typeof env,
        tenant,
        clock,
      });
    let app = await open();
    let startedAt = clock.now().getTime();
    const steps = (minutes * 60_000) / STEP_MS;
    try {
      for (let step = 0; step < steps; step += 1) {
        if (restartEveryMs !== null && clock.now().getTime() - startedAt >= restartEveryMs) {
          await app.stop();
          app = await open();
          startedAt = clock.now().getTime();
        }
        await app.commands.placeOrder({ orderId: `o-${step}`, total: 1, customer: `c-${step}` });
        await app.runUntilIdle();
        clock.advance(STEP_MS);
      }
    } finally {
      await app.stop();
    }
    return { raised: ledger.raised, listed: ledger.listed, steps };
  });
};

// The most keys any listing of the generation's mark read, in the run's first and last ten
// minutes, and the most a value raised in the three delays before could leave: KV shows a key,
// and its removal, within the delay, and a prune lets go of what is older than the delay.
const costOf = ({ raised, listed }: Awaited<ReturnType<typeof run>>) => {
  const generation = listed.filter(({ mark }) => mark === "restore:generation");
  const [first] = generation;
  const last = generation.at(-1);
  const within = (from: number, to: number) =>
    Math.max(0, ...generation.filter(({ at }) => at >= from && at < to).map(({ keys }) => keys));
  const tenMinutes = 10 * 60_000;
  return {
    first: within(first?.at ?? 0, (first?.at ?? 0) + tenMinutes),
    last: within((last?.at ?? 0) - tenMinutes, (last?.at ?? 0) + 1),
    overBound: generation.filter(
      ({ at, keys }) =>
        keys >
        raised.filter(
          (key) =>
            key.mark === "restore:generation" && key.at <= at && key.at > at - 3 * KV_LIST_DELAY_MS,
        ).length +
          1,
    ),
  };
};

describe("what reading the KV ledger's marks costs", () => {
  it("lists a bounded number of keys however long a busy object runs", async () => {
    const result = await run({ tenant: "marks-busy", minutes: 30, restartEveryMs: null });
    const cost = costOf(result);
    expect(Math.min(cost.first, cost.last)).toBeGreaterThan(0);
    expect(cost.overBound).toEqual([]);
    expect(cost.last).toBeLessThanOrEqual(cost.first);
    // Every look lists the generation's mark and the count's; what lists the generation's alone is
    // a prune, once a delay rather than with every raise.
    const lists = (mark: string) => result.listed.filter((listed) => listed.mark === mark).length;
    expect(lists("restore:generation") - lists("restore:count")).toBeLessThanOrEqual(
      (30 * 60_000) / KV_LIST_DELAY_MS + 2,
    );
  }, 120_000);

  it("lists a bounded number of keys however many instances start and stop before a delay passes", async () => {
    const result = await run({
      tenant: "marks-restarting",
      minutes: 30,
      restartEveryMs: KV_LIST_DELAY_MS / 2,
    });
    const cost = costOf(result);
    expect(Math.min(cost.first, cost.last)).toBeGreaterThan(0);
    expect(cost.overBound).toEqual([]);
    expect(cost.last).toBeLessThanOrEqual(cost.first);
  }, 120_000);
});
