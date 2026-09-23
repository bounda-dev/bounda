import { cloudflare } from "../src/definition.ts";
import { createBoundaObject, createWorker } from "../src/index.ts";
import { quietRegistry, registry } from "./app.ts";
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
 * The same app without policies or processes.
 */
export const QuietStore = createBoundaObject({
  registry: quietRegistry,
  config: { storage: cloudflare() },
  clock,
});

export default createWorker({ binding: "STORE" });
