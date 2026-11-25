import { DurableObject } from "cloudflare:workers";
import { createSequentialIdGenerator } from "@bounda-dev/core";
import { masterKey } from "@bounda-dev/core/config";
import { cloudflare } from "../src/definition.ts";
import { kvForgetLedger } from "../src/forget-ledger.ts";
import { createBoundaKeeper, createBoundaObject, createWorker } from "../src/index.ts";
import { durableObjectForgetLedger, durableObjectTenantKeys } from "../src/keeper-stores.ts";
import { kvTenantKeys } from "../src/tenant-keys.ts";
import {
  processRegistry,
  quietRegistry,
  regionRegistry,
  registry,
  SNAPSHOT_EVERY,
  slicedRegistry,
} from "./app.ts";
import { clock } from "./clock.ts";
import { recordingLogger } from "./logs.ts";

// Every object's keys: the master key in the Worker's `BOUNDA_MASTER_KEY`, each tenant's key in
// the `TENANT_KEYS` KV namespace, under the object's name or id.
const keys = {
  keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
  tenantKeys: kvTenantKeys({ binding: "TENANT_KEYS" }),
};

/**
 * The object under test: the order app on the Durable Object's own SQLite.
 */
export const Store = createBoundaObject({
  registry,
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  clock,
  passesPerAlarm: 20,
});

/**
 * The same app with a process besides the policy.
 */
export const ProcessStore = createBoundaObject({
  registry: processRegistry,
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  clock,
  passesPerAlarm: 20,
});

/**
 * The same app without policies or processes.
 */
export const QuietStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  clock,
});

/**
 * The same app without policies or processes, forgetting a person an hour after their last
 * activity.
 */
export const RetainedStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare(), runtime: { personalData: { ...keys, retention: "1h" } } },
  clock,
});

/**
 * The same app without policies or processes, whose tenant's key a test forgets or rotates.
 */
export const WrappedStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  clock,
});

/**
 * The same app without policies or processes, recording every forgetting in the Worker's
 * `FORGET_LEDGER` KV namespace.
 */
export const LedgerStore = createBoundaObject({
  registry: quietRegistry,
  config: {
    storage: cloudflare(),
    runtime: {
      personalData: {
        ...keys,
        forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) },
      },
    },
  },
  clock,
});

/**
 * The same app without policies or processes, recording every forgetting in `FORGET_LEDGER` and
 * rebuilding one event per slice, whose objects the witness tests watch.
 */
export const WitnessedStore = createBoundaObject({
  registry: quietRegistry,
  config: {
    storage: cloudflare(),
    runtime: {
      personalData: {
        ...keys,
        forgetLedger: { store: kvForgetLedger({ binding: "FORGET_LEDGER" }) },
      },
    },
  },
  clock,
  eventsPerRebuildSlice: 1,
});

/**
 * The same app without policies and with a second read model, in small steps: one event per
 * batch, per rebuild slice and per alarm pass. Its ids are sequential and its logs are what the
 * tests read.
 */
export const SlicedStore = createBoundaObject({
  registry: slicedRegistry,
  config: {
    storage: cloudflare(),
    runtime: { dispatcher: { batchSize: 1 }, personalData: keys },
  },
  clock,
  eventsPerRebuildSlice: 1,
  passesPerAlarm: 1,
  ids: createSequentialIdGenerator({ prefix: "sliced" }),
  logger: recordingLogger,
});

/**
 * The same app without policies or processes, snapshotting an order every few events, its state
 * fingerprinted as the generator would.
 */
export const SnapshotStore = createBoundaObject({
  registry: {
    ...quietRegistry,
    aggregates: {
      order: { ...quietRegistry.aggregates.order, stateFingerprint: "cost" },
    },
  },
  config: {
    storage: cloudflare(),
    runtime: {
      overrides: { order: { snapshot: { every: SNAPSHOT_EVERY } } },
      personalData: keys,
    },
  },
  clock,
});

/**
 * The app without policies, with an implementation its `create` builds from the object's `env`.
 */
export const RegionStore = createBoundaObject({
  registry: regionRegistry,
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  clock,
});

const eu = cloudflare({ binding: "EU_STORE", jurisdiction: "eu" });
const unboundEu = cloudflare({ binding: "UNBOUND", jurisdiction: "eu" });
// The master key, declared in the EU with every other store of the EU objects.
const euKeyWrapper = masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" });

/**
 * The app without policies or processes, kept in the EU, which workerd cannot do: its own binding
 * in its `env` tells it so, and it starts without one. Its keys and ledger are in the EU keeper.
 */
export const EuStore = createBoundaObject({
  registry: quietRegistry,
  config: {
    storage: eu,
    runtime: {
      personalData: {
        keyWrapper: euKeyWrapper,
        tenantKeys: durableObjectTenantKeys({ storage: eu, binding: "EU_KEEPER" }),
        forgetLedger: { store: durableObjectForgetLedger({ storage: eu, binding: "EU_KEEPER" }) },
      },
    },
  },
  clock,
});

/**
 * The same, with no binding of its own in its `env`: nothing tells it workerd has no
 * jurisdictions, so it refuses to start outside the EU.
 */
export const UnboundEuStore = createBoundaObject({
  registry: quietRegistry,
  config: {
    storage: unboundEu,
    runtime: {
      personalData: {
        keyWrapper: euKeyWrapper,
        tenantKeys: durableObjectTenantKeys({ storage: unboundEu, binding: "EU_KEEPER" }),
      },
    },
  },
  clock,
});

/**
 * The keeper of the EU objects' keys and ledgers, which starts where workerd has no jurisdictions
 * as they do.
 */
export const EuKeeper = createBoundaKeeper({ config: { storage: eu } });

/**
 * A keeper with no binding of the app in its `env`, which refuses every call outside the EU.
 */
export const UnboundEuKeeper = createBoundaKeeper({ config: { storage: unboundEu } });

/**
 * A keeper with no binding of the app in its `env` whose tenant keys are kept in the US under a
 * safeguard and whose ledger stays in the EU with the objects: it refuses each store's calls
 * outside that store's jurisdiction.
 */
export const UnboundSplitKeeper = createBoundaKeeper({
  config: {
    storage: unboundEu,
    runtime: {
      personalData: {
        tenantKeys: durableObjectTenantKeys({
          storage: unboundEu,
          binding: "UNBOUND_SPLIT_KEEPER",
          jurisdiction: "us",
          safeguard: "adequacy",
        }),
        forgetLedger: {
          store: durableObjectForgetLedger({ storage: unboundEu, binding: "UNBOUND_SPLIT_KEEPER" }),
        },
      },
    },
  },
});

/**
 * The keeper of every tenant's key and ledger kept in no jurisdiction.
 */
export const Keeper = createBoundaKeeper({ config: { storage: cloudflare() } });

const kept = cloudflare({ binding: "KEPT_STORE" });

/**
 * The keeper of the keys and ledgers of `KeptStore`'s objects alone, so the Worker's schedule
 * wakes none of the tenants other tests keep.
 */
export const KeptKeeper = createBoundaKeeper({ config: { storage: kept } });

/**
 * The configuration of an app whose tenant keys and ledger the keeper holds.
 */
export const keptConfig = {
  storage: kept,
  runtime: {
    personalData: {
      keyWrapper: keys.keyWrapper,
      tenantKeys: durableObjectTenantKeys({ storage: kept, binding: "KEPT_KEEPER" }),
      forgetLedger: { store: durableObjectForgetLedger({ storage: kept, binding: "KEPT_KEEPER" }) },
    },
  },
};

/**
 * The app without policies or processes, its tenant's key and ledger in the keeper.
 */
export const KeptStore = createBoundaObject({ registry: quietRegistry, config: keptConfig, clock });

/**
 * The Worker of the objects whose keys the keeper holds.
 */
export const keptWorker = createWorker({ config: keptConfig, tenantOf: () => "default" });

/**
 * An object with no app in it: an empty SQLite for the storage contracts.
 */
export class Bare extends DurableObject {}

export default createWorker({
  config: { storage: cloudflare(), runtime: { personalData: keys } },
  tenantOf: (request) => request.headers.get("x-bounda-tenant") ?? "default",
});
