import { DurableObject } from "cloudflare:workers";
import { createSequentialIdGenerator } from "@bounda-dev/core";
import { masterKey } from "@bounda-dev/core/config";
import { cloudflare } from "../src/definition.ts";
import { kvForgetLedger } from "../src/forget-ledger.ts";
import { createBoundaObject, createWorker } from "../src/index.ts";
import { processRegistry, quietRegistry, regionRegistry, registry, slicedRegistry } from "./app.ts";
import { clock } from "./clock.ts";
import { recordingLogger } from "./logs.ts";

/**
 * The object under test: the order app on the Durable Object's own SQLite.
 */
export const Store = createBoundaObject({
  registry,
  config: { storage: cloudflare() },
  clock,
  passesPerAlarm: 20,
});

/**
 * The same app with a process besides the policy.
 */
export const ProcessStore = createBoundaObject({
  registry: processRegistry,
  config: { storage: cloudflare() },
  clock,
  passesPerAlarm: 20,
});

/**
 * The same app without policies or processes.
 */
export const QuietStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare() },
  clock,
});

/**
 * The same app without policies or processes, forgetting a person an hour after their last
 * activity.
 */
export const RetainedStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare(), runtime: { personalData: { retention: "1h" } } },
  clock,
});

/**
 * The same app without policies or processes, its personal keys wrapped under the master key in
 * the Worker's `BOUNDA_MASTER_KEY`.
 */
export const WrappedStore = createBoundaObject({
  registry: quietRegistry,
  config: {
    storage: cloudflare(),
    runtime: { personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) } },
  },
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
    runtime: { personalData: { forgetLedger: kvForgetLedger({ binding: "FORGET_LEDGER" }) } },
  },
  clock,
});

/**
 * The same app without policies and with a second read model, in small steps: one event per
 * batch, per rebuild slice and per alarm pass. Its ids are sequential and its logs are what the
 * tests read.
 */
export const SlicedStore = createBoundaObject({
  registry: slicedRegistry,
  config: { storage: cloudflare(), runtime: { dispatcher: { batchSize: 1 } } },
  clock,
  eventsPerRebuildSlice: 1,
  passesPerAlarm: 1,
  ids: createSequentialIdGenerator({ prefix: "sliced" }),
  logger: recordingLogger,
});

/**
 * The app without policies, with an implementation its `create` builds from the object's `env`.
 */
export const RegionStore = createBoundaObject({
  registry: regionRegistry,
  config: { storage: cloudflare() },
  clock,
});

/**
 * An object with no app in it: an empty SQLite for the storage contracts.
 */
export class Bare extends DurableObject {}

export default createWorker({
  config: { storage: cloudflare() },
  tenantOf: (request) => request.headers.get("x-bounda-tenant") ?? "default",
});
