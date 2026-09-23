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

Or deploy the same project to your account without cloning anything:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)

The button forks [bounda-cloudflare-template](https://github.com/bounda-dev/bounda-cloudflare-template)
into your GitHub account, creates the Durable Object and deploys it; every push to the fork
deploys again.

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
  "assets": { "directory": "./public" },
  "compatibility_date": "2026-09-21",
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "Store" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store"] }],
  "observability": { "enabled": true },
  "upload_source_maps": true
}
```

`public/index.html` is a page that places orders and lists them through the API, served as a
static asset. `npm run dev` starts `wrangler dev` on http://localhost:8787; `npm run deploy`
deploys to your account.

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
typed from your modules, plus `getLag()`, `deadLetters` and `rebuildReadModel`. A refusal comes
back as an `Error` with the same `name`, `message`, `code` and, for validation, `issues`, whatever
the Worker's compatibility date: the object answers refusals as data and `connect` throws them
again, because RPC drops an error's own properties on older dates. Check `error.code`, not
`instanceof`.

## Testing

The tests run inside `workerd` through
[`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
which needs Vitest 4.1, so a Cloudflare project pins that version. `tests/orders.test.ts` runs the
domain on the in-memory adapter with `createTestApp`, as in any Bounda project;
`tests/api.test.ts` sends requests to the Worker with `SELF.fetch` and reaches the real Durable
Object and its SQLite. The adapter's own suite runs every storage contract inside `workerd` too.

Types for the bindings come from `wrangler types`, which writes `worker-configuration.d.ts` from
`wrangler.jsonc`; `dev`, `typecheck` and `check` run it, and `tsconfig.json` lists that file
instead of `@cloudflare/workers-types`. There is no `prepare` script: every script runs
`bounda generate` itself, and `npm install --package-lock-only` stays possible without
`node_modules`.

## Limits worth knowing

- **One object lives in one region.** Users far from it pay the latency on every command.
- **A projection must not wait on anything but its read model.** Each batch runs inside the
  object's storage transaction, and while one is open the runtime holds the object's other
  events back. A projection that awaits a `fetch` or a timer can then wait forever for an event
  queued behind it, and the object stops. Projections that only use `table` and `client` never
  hit this; anything else belongs in a policy, on every adapter.
- **A rebuild runs in slices.** `rebuildReadModel` projects the first
  `eventsPerRebuildSlice` events (5,000 by default, an option of `createBoundaObject`) and
  answers `done: false` when the stream is longer; the object's alarm runs one slice after
  another until the rebuilt table takes the live one's place. Queries read the live table all the
  while. Each slice is one more request to the object, and a slice that fails is retried after
  the dispatcher's poll interval.
- **Cost.** Row writes are what runs out first. A command that inserts one read-model row writes
  seven rows, indexes included: four for the event, two for the read-model row, one for the
  checkpoint. On the free plan's 100,000 row writes a day that is about fourteen thousand
  commands, when the app has no policies or processes and so no alarm to run after each one.
  Each policy or process reaction adds its own writes, and the alarm that runs it is one more
  request. On the paid plan the first fifty million row writes a month are included, and a
  million commands beyond that cost around eight dollars.
- **Every published version is a prerelease**, like the rest of Bounda.
