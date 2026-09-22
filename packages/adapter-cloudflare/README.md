<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.bounda.dev/wordmark-dark.svg" />
    <img src="https://docs.bounda.dev/wordmark-light.svg" alt="Bounda" width="160" />
  </picture>
</p>

# @bounda-dev/adapter-cloudflare

A [Bounda](https://docs.bounda.dev) store in a Cloudflare Durable Object: the events, the read
models and the scheduled work in the object's own SQLite, one object per tenant, and no server
or background process to run.

```bash
npm create bounda@latest my-app -- --framework cloudflare
```

Or by hand:

```ts
// bounda.config.ts
import { cloudflare } from "@bounda-dev/adapter-cloudflare";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({ storage: cloudflare() });
```

```ts
// src/worker.ts
import { createBoundaObject, createWorker } from "@bounda-dev/adapter-cloudflare";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

export const Store = createBoundaObject({ registry, config });
export default createWorker({ binding: "STORE" });
```

`wrangler.jsonc` binds `STORE` to the `Store` class with a `new_sqlite_classes` migration.

- A command resolves once its events are stored and every read model reflects them.
- Policies, processes, scheduled commands and retries run in the object's alarm, which it arms
  itself.
- `createWorker` serves `POST /commands/<name>` and `POST /queries/<name>` as JSON, one store per
  `x-bounda-tenant` header. It has no authentication: a starting point. Your own `fetch` talks to a
  store with `connect(stub)`, which types `commands` and `queries` from your modules.

## Alpha

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev](https://docs.bounda.dev). Source and issues:
[github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
