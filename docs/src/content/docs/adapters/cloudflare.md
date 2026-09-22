---
title: Cloudflare
description: A Bounda store in a Durable Object, one per tenant, with no server and no background process.
sidebar:
  order: 3
---

`@bounda-dev/adapter-cloudflare` runs a Bounda app on Cloudflare: a Worker in front and a
[Durable Object](https://developers.cloudflare.com/durable-objects/) per tenant, each holding
its events, its read models and its scheduled work in its own SQLite. There is nothing else to
deploy or to keep running.

```bash
npm create bounda@latest my-app -- --framework cloudflare
```

That gives you the order app of [Getting started](/getting-started/) with three extra files:

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

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-21",
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "Store" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store"] }]
}
```

`npm run dev` starts `wrangler dev`; `npm run deploy` deploys to your account.

## How it runs

One Durable Object is one store: the same single ordered log, subscribers and checkpoints as on
SQLite or PostgreSQL, in the object's SQLite. The SQL is literally the same code as the
[SQLite adapter](/adapters/sqlite/). What changes is who does the background work, because a
Durable Object has no loop running between requests:

- **A command** stores its events and brings every read model up to date before it answers, so
  the query that follows already sees it. A command is read-your-writes by construction.
- **Policies, processes, scheduled commands and retries** run in the object's **alarm**, right
  after the command answers, in their own event. A policy that calls a slow service never slows
  the command down.
- **The object arms its own alarm**: at once when work is left or new events arrived, after a
  retry interval when a retry back-off is holding events, at the due time of the next scheduled
  command or process time-out, whichever comes first. Nothing is armed when nothing is pending.
- **The alarm never throws.** Cloudflare retries a failing alarm six times and then drops it;
  the object catches every failure, logs it and arms itself again.

`createBoundaObject` accepts `passesPerAlarm` (50 by default): how many rounds of work one alarm
does before it yields and wakes itself again.

## One object per tenant

`createWorker` addresses the object by the `x-bounda-tenant` header, `default` without it. Each
tenant is its own object, with its own events and read models, and nothing is shared between
them. That is also how a Cloudflare app scales: one object handles in the order of a thousand
requests a second, and [How Bounda runs](/guides/how-it-runs/) explains why the way out is more
stores, not a split log.

## The HTTP API

`createWorker({ binding })` serves one app as JSON:

| Request | Answer |
| --- | --- |
| `POST /commands/<name>` with the payload as the body | The dispatch result, once the read models reflect it. `?delay=10m` schedules it |
| `POST /queries/<name>` with the payload as the body | The query's result |

Refusals come back as `{ "error": { "code", "message" } }`: 400 for `VALIDATION_FAILED`
(with the `issues`) and `INVALID_JSON`, 404 for `NOT_FOUND`, 409 for `DOMAIN_ERROR`,
`CONCURRENCY_CONFLICT` and `CHAIN_DEPTH_EXCEEDED`. Anything else is a 500 whose message goes to
the logs, not to the caller.

It has **no authentication** and no operator endpoint, on purpose: it is a starting point. An
app with users writes its own `fetch` and talks to a store with `connect`:

```ts
import { connect } from "@bounda-dev/adapter-cloudflare";

export default {
  async fetch(request, env) {
    const tenant = await tenantOfUser(request); // your authentication
    const store = connect(env.STORE.get(env.STORE.idFromName(tenant)));
    await store.commands.placeOrder({ orderId, customerId, total });
    return Response.json(await store.queries.listOrders({ customerId }));
  },
} satisfies ExportedHandler<Env>;
```

`connect(stub)` gives the same `commands` and `queries` as `app.commands` and `app.queries`,
typed from your modules, plus `getLag()`, `deadLetters` and `rebuildReadModel`. Errors keep their
class and their `code` across the call.

## Testing

`tests/` runs the domain on the in-memory adapter with `createTestApp`, in Node, as in any Bounda
project. The object itself is the same runtime on another SQLite; the adapter's own suite runs
every storage contract inside `workerd`.

## Limits worth knowing

- **One object lives in one region.** Users far from it pay the latency on every command.
- **A rebuild runs in one request**, bounded by Cloudflare's five minutes of CPU. That covers
  hundreds of thousands of events in local SQLite; resuming a rebuild across alarms is not built
  yet.
- **Cost.** Every command writes several rows (the event, checkpoints, ledgers, read-model rows).
  The free plan's 100,000 row writes a day are in the order of ten to twenty thousand commands;
  on the paid plan the first fifty million writes a month are included.
- **Every published version is a prerelease**, like the rest of Bounda.
