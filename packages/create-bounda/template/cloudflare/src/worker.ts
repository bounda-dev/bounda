import { createBoundaObject, createWorker } from "@bounda-dev/adapter-cloudflare";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

// One store per Durable Object: its events, read models and alarms live in the object's SQLite.
export const Store = createBoundaObject({ registry, config });

// POST /commands/<name> and POST /queries/<name>, one store per x-bounda-tenant header.
export default createWorker({ binding: "STORE" });
