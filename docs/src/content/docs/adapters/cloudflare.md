---
title: Cloudflare
description: A Bounda store in a Durable Object, one per tenant, with no server and no background process.
sidebar:
  order: 3
---

`@bounda-dev/cloudflare` runs a Bounda app on Cloudflare: a Worker in front and a
[Durable Object](https://developers.cloudflare.com/durable-objects/) per tenant, each holding
its events, its read models and its scheduled work in its own SQLite. There is nothing else to
deploy or to keep running.

```bash
npm create bounda@latest my-app -- --runtime cloudflare
```

Or deploy the same project to your account without cloning anything:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)

The button forks
[bounda-cloudflare-template](https://github.com/bounda-dev/bounda-cloudflare-template) into your
GitHub account, creates the Durable Object and deploys it; every push to the fork deploys again.

That gives you the order app of [Getting started](/getting-started/) with three extra files:

```ts
// bounda.config.ts
import { cloudflare } from "@bounda-dev/cloudflare";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({ storage: cloudflare() });
```

```ts
// src/worker.ts
import { createBoundaObject, createWorker } from "@bounda-dev/cloudflare";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

export const Store = createBoundaObject({ registry, config });
export default createWorker({
  config,
  tenantOf: (request) => request.headers.get("x-bounda-tenant") ?? "default",
});
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
deploys to your account. A React Router app runs on Cloudflare the same way, with the object
behind its loaders and actions: see [Bounda with React Router](/guides/react-router/#on-cloudflare),
or start one with
`npm create bounda@latest my-app -- --runtime cloudflare --framework react-router`.

## How it runs

One Durable Object is one store: the same event store and global stream, subscribers and checkpoints
as on SQLite or PostgreSQL, in the object's SQLite. The SQL is literally the same code as the
[SQLite adapter](/adapters/sqlite/). What changes is who does the background work, because a Durable
Object has no loop running between requests:

- **A command** stores its events and brings the read models that project them up to date before
  it answers, so the query that follows already sees it. That is the default; with
  `consistency: "eventual"` in `connect` or `createWorker`, a command answers once its events are
  stored and the alarm projects them right after
  ([the host decides read-your-writes](/concepts/read-your-writes/)).
- **Policies, processes, scheduled commands and retries** run in the object's **alarm**, right
  after the command answers, in their own event. A policy that calls a slow service never slows
  the command down.
- **The object arms its own alarm**: at once when work is left or new events arrived, after a
  retry interval when a retry back-off is holding events, at the due time of the next scheduled
  command or process timeout, whichever comes first. Nothing is armed when nothing is pending.
- **The alarm never throws.** Cloudflare retries a failing alarm six times and then drops it;
  the object catches every failure, logs it and arms itself again.

`createBoundaObject` accepts `passesPerAlarm` (50 by default): how many rounds of work one alarm
does before it yields and wakes itself again.

The object and the Worker log one JSON line per entry, which Workers Logs parses into fields;
`workersLogger` is that logger, and a `logger` option takes another. A failure is logged by its
class and its `code`, without its message, as [error text](/reference/observability/#error-text)
says by default. The configuration is the same bundle wherever it is deployed, so
`BOUNDA_ERROR_TEXT` in the Worker's `env` decides instead: `include` there, in `.dev.vars`, puts
the message and the stack in the logs under `wrangler dev`, for the object and the Worker alike,
and a deployment, which never reads `.dev.vars`, keeps them out. `create-bounda` writes that line;
`.dev.vars.example` only mentions it, so Deploy to Cloudflare never asks for it.

## Ports and `env`

A port implementation that exports `create` receives the object's `env`: the Worker's
bindings and variables, typed as `Cloudflare.Env` from what `wrangler types` writes. That is how
a queue, a KV namespace, a service binding or a secret reaches it. `create` runs once per object,
when it starts.

```ts
// app/domain/order/infrastructure/notifier/queue.ts
import type { CreateImplementation } from "@bounda-dev/core";
import type { Notifier } from "../../notifier.ts";

export const create: CreateImplementation<Notifier> = ({ env }) => (message) =>
  env.NOTIFICATIONS.send(message);
```

`create` also receives the object's name as `tenant`, the one `idFromName` addressed it by, so an
implementation can serve each tenant with its own account or key
([an account per tenant](/guides/calling-the-outside-world/#an-account-per-tenant)). An object
reached through an id without a name, from `newUniqueId` or `idFromString`, has no `tenant`; the
Worker of `createWorker` and the React Router host always address it by name.

`bounda.config.ts` can choose an implementation from the same variables, since `env` from
`cloudflare:workers` is readable when the Worker imports it:

```ts
import { env } from "cloudflare:workers";

export default defineConfig({
  storage: cloudflare(),
  ports: { order: { notifier: env.NOTIFIER === "memory" ? "memory" : "queue" } },
});
```

Since an empty object has none of those bindings, `createApp` and `createTestApp` require `env`
in a Cloudflare project whose registry has an implementation with `create`, instead of
defaulting to `{}`.

A Durable Object never stops its app, so `[Symbol.asyncDispose]` on what `create` returns only
runs under `createTestApp` or an app you stop yourself.

## The master key

`masterKey({ from: "BOUNDA_MASTER_KEY" })` reads the object's `env` too, so the
[master key](/guides/personal-data/#a-master-key) that wraps every person's key is a secret of
the Worker, shared by every tenant's object, and never in the object's SQLite. A project from
`create-bounda` has one generated in `.dev.vars`, which `wrangler dev` and the tests in `workerd`
read and Git ignores, and a `.dev.vars.example` that names it. Before the first deploy, set it:

```sh
npx wrangler secret put BOUNDA_MASTER_KEY
```

Deploy to Cloudflare asks for it from `.dev.vars.example`. An object started without it fails to
start, with a `ConfigurationError` that names the variable.

## The forget ledger

Cloudflare restores a Durable Object's storage to a point in time, which brings back the keys of
everyone forgotten after it. `kvForgetLedger({ binding })` keeps the record of every forgetting
in a KV namespace instead, outside every object, and an object that starts forgets again whoever
its restored storage brought back; restoring the storage restarts the object. Bind the namespace
in `wrangler.jsonc` and name it in `runtime.personalData.forgetLedger.store`; an object whose
`env` lacks the binding, or that was reached through an id without a name, fails to start with a
`ConfigurationError`. Each object keeps its entries under its own name, and reads the ledger once
more a minute after it starts, since KV may take that long to list a key. The periodic
reconciliation never wakes an object on its own, and with `keepFor` each key expires in KV by
itself; `bounda forget-ledger expire` gives the keys written before `keepFor` was set theirs.
Every forgetting writes its intention to KV before the object commits it, so one the object did not
get to commit, because it was evicted or its transaction failed, is committed at its next start;
with `strict`, a forgetting KV does not take fails and forgets nobody. An entry lives in its key's
metadata, which KV caps at 1024 bytes; the categories and keys of a forgetting with too many to fit
there, some thirty, go to the key's value, which a read fetches for the entries it hands out alone,
and `bounda forget-ledger expire` writes back as it was, leaving alone a key gone meanwhile. See
[backups](/guides/personal-data/#backups).

## One object per tenant

`createWorker` addresses the object by the tenant `tenantOf` names for each request: in the
project above, the `x-bounda-tenant` header, `default` without it. Each tenant is its own object,
with its own events and read models, and nothing is shared between them. That is also how a
Cloudflare app scales: one object handles in the order of a thousand requests a second, and
[How Bounda runs](/concepts/how-it-runs/) explains why the way out is more stores, not a split
global stream.

## The HTTP API

`createWorker({ config, tenantOf })` serves one app as JSON, through the Durable Object binding
`cloudflare()` names: `STORE` unless `cloudflare({ binding })` says otherwise.

| Request | Answer |
| --- | --- |
| `POST /commands/<name>` with the payload as the body | The dispatch result, once the read models reflect it, or once its events are stored with `createWorker({ config, tenantOf, consistency: "eventual" })`. `?delay=10m` schedules it |
| `POST /queries/<name>` with the payload as the body | The query's result |

Refusals come back as `{ "error": { "code", "message" } }` with the statuses in
[errors over HTTP](/reference/errors/#over-http); anything else is a 500 whose message goes to the
logs, not to the caller, under the rule of [error text](/reference/observability/#error-text). A body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` unless
`createWorker({ config, tenantOf, maxPayloadBytes })` says otherwise, is refused with a 413
before it is read.

It has **no authentication** and no operator endpoint, on purpose: it is a starting point. For
the same reason it never [forgets](/guides/personal-data/) anyone, which cannot be undone, nor
restricts anyone's processing. An app with users writes its own `fetch` and talks to a store with
`connect`, whose `forget`, `restrict` and `unrestrict` it calls behind its own authentication:

```ts
import { connect } from "@bounda-dev/cloudflare";

export default {
  async fetch(request, env) {
    const tenant = await tenantOfUser(request); // your authentication
    const store = connect(env.STORE.get(env.STORE.idFromName(tenant)));
    await store.commands.placeOrder({ orderId, customerId, total });
    return Response.json(await store.queries.listOrders({ customerId }));
  },
} satisfies ExportedHandler<Env>;
```

`connect(stub)` gives a `BoundaClient`, the type `@bounda-dev/core` gives to what a request sees
of an app wherever it runs: the same `commands` and `queries` as `app.commands` and
`app.queries`, typed from your modules, plus `getLag()`, `status()`, `events`, `deadLetters`,
`subscriberFailures`, `rebuildReadModel`, `forget`, `exportPersonalData`, `restrict` and
`unrestrict`. `bounda status` runs where Node can open the store, so a Durable Object's is read
through `status()`, from an admin route of the Worker, say.
Its commands resolve once the read models reflect them; `connect(stub, { consistency: "eventual" })`
resolves them once their events are stored, for a request that reads nothing after it. A refusal comes
back as an `Error` with the same `name`, `message`, `code` and, for validation, `issues`, whatever
the Worker's compatibility date: the object answers refusals as data and `connect` throws them
again, because RPC drops an error's own properties on older dates. Check `error.code`, not
`instanceof`. A command's `signal` only counts before the call leaves the Worker: RPC cannot
carry it into the object, where the command runs to the end, bounded by
`runtime.commands.timeout`.

## Who makes a request

Every event can say who acted: the `actor` in its metadata (see
[Who acts](/concepts/ids-causation-and-correlation/#who-acts)). `connect(stub).as(userId)` gives
the same client acting as that id: every call sends it over RPC, and the object acts as it, so the
commands record it on their events, and `forget`, `restrict` and `unrestrict` on theirs.

```ts
const store = connect(env.STORE.get(env.STORE.idFromName(tenant))).as(user.id);
await store.commands.placeOrder({ orderId, customerId, total });
```

`createWorker` takes `actorOf`, beside `tenantOf`: a function of the request that names who makes
it, or `undefined` for nobody. Its commands and queries then act as that id.

```ts
export default createWorker({
  config,
  tenantOf: (request) => request.headers.get("x-bounda-tenant") ?? "default",
  actorOf: async (request) => (await verifiedUser(request))?.id, // your authentication
});
```

The worker trusts what `actorOf` returns: name the user the request proves it is, never a header
anyone can send. The actor is an id, never a name or an email, since events keep it in the clear.
`as` throws `ValidationError` for one that is not a string of 1 to 255 characters, and the object
refuses one that reaches it that way with the same error. An `actorOf` that names such an actor is
the Worker's mistake, not the caller's: the request gets a 500 and the log says so, without the
value.

## Testing

The tests run inside `workerd` through
[`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
on the same Vitest as a Node project. `tests/orders.test.ts` runs the domain on the in-memory
adapter with `createTestApp`, as in any Bounda project; `tests/api.test.ts` sends requests to
the Worker with `SELF.fetch` and reaches the real Durable Object and its SQLite. The adapter's own
suite runs every storage contract inside `workerd` too.

`expectForgotten` searches the object's own SQLite through `durableObjectAdapter`, called inside
the object with `runInDurableObject`, for the values of the person's export taken before
`forget`:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { connect, durableObjectAdapter } from "@bounda-dev/cloudflare";
import { expectForgotten } from "@bounda-dev/core/testing";

const stub = env.STORE.get(env.STORE.idFromName("forgets"));
const store = connect(stub);
// ...
const before = await store.exportPersonalData("ada");
await store.forget("ada");
await runInDurableObject(stub, (_object, state) =>
  expectForgotten(durableObjectAdapter({ storage: state.storage }), "ada", { before }),
);
```

Pass `durableObjectAdapter` the options the configuration gives `cloudflare()`, `tablePrefix`
among them.

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
  answers `done: false` when the global stream is longer; the object's alarm runs one slice after
  another until the rebuilt table takes the live one's place. Queries read the live table all the
  while. Each slice is one more request to the object, and a slice that fails is retried after
  the dispatcher's poll interval.
- **Cost.** Row writes are what runs out first. Cloudflare counts every index a write updates as
  one more row written, so each index declared on a view adds a row to every read-model row a
  command inserts or changes. The view in the project `create-bounda` scaffolds for Cloudflare,
  with its primary key and one `.index()`, makes a command that places an order write eight rows:
  four for the event, three for the read-model row (the row, its primary key and the index), one
  for the checkpoint. On the free plan's 100,000 row writes a day that is about 12,500 commands,
  when the app has no policies or processes and so no alarm to run after each one.
  Each policy or process reaction adds its own writes, and the alarm that runs it is one more
  request. A scheduled command, dead letter, snapshot or remembered rejection that holds personal
  data writes two more rows for each person it names, and as many again when it goes: the entry
  in the table that finds it by person for `forget` and the export, and that entry's index. `"eventual"` consistency saves nothing: in an app without policies or processes each
  command then arms the alarm, which Cloudflare bills as one more row written, and the alarm that
  projects is one more request; with them, the alarm runs after each command anyway and projects
  in the same request. What it buys is a command that answers sooner. On the paid plan the first
  fifty million row writes a month are included, and a million commands beyond that cost around
  eight dollars.
