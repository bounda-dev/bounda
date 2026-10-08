import { DurableObject } from "cloudflare:workers";
import { cloudflare } from "../src/definition.ts";
import { createBoundaObject, createWorker } from "../src/index.ts";
import { processRegistry, quietRegistry, regionRegistry, registry } from "./app.ts";
import { clock } from "./clock.ts";

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
 * The same app without policies, rebuilding one event per slice.
 */
export const SlicedStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare(), runtime: { dispatcher: { batchSize: 1 } } },
  clock,
  eventsPerRebuildSlice: 1,
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

export default createWorker({ binding: "STORE" });
