import { createBoundaObject } from "@bounda-dev/cloudflare";
import { createRequestHandler } from "react-router";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

/**
 * The Durable Object class bound as STORE in wrangler.jsonc. Each instance is one tenant's store,
 * with everything it keeps in the object's own SQLite; app/tenant.ts picks it for each request.
 */
export const Store = createBoundaObject({ registry, config });

const handler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default { fetch: (request: Request) => handler(request) };
