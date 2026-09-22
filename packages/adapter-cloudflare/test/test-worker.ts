import { cloudflare } from "../src/definition.ts";
import { createBoundaObject, createWorker } from "../src/index.ts";
import { registry } from "./app.ts";
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

export default createWorker({ binding: "STORE" });
