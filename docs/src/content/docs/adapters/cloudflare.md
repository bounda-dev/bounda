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

export default defineConfig({ storage: cloudflare({ jurisdiction: "eu" }) });
```

```ts
// src/worker.ts
import { createBoundaObject, createWorker } from "@bounda-dev/cloudflare";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

export class Store extends createBoundaObject({ registry, config }) {}
export default createWorker({
  config,
  registry,
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

`jurisdiction: "eu"` keeps every object in the EU: see [Data location](#data-location).
`Store` is a class extending what `createBoundaObject` returns, so `wrangler types` gives
`env.STORE` the object's own type, which a test reaches with `runInDurableObject`.
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
- **The object arms its own alarm**: at once when work is left or new events arrived that a
  subscriber handles, after a retry interval when a retry back-off is holding events, at the due
  time of the next scheduled command or process timeout, whichever comes first. Nothing is armed
  when nothing is pending.
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
reached through an id without a name, from `newUniqueId` or `idFromString`, receives the id as
its `tenant`; the Worker of `createWorker`, the React Router host and `tenantStub` always address
it by name.

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

## Tenant keys

Each object is a [tenant](/guides/personal-data/#tenants), named by the name it was reached
through, `idFromName`'s, or by its id when it has none; its key wraps the keys of its persons and of
its database, and lives outside the object, so that [forgetting the
tenant](/guides/personal-data/#forgetting-a-tenant) reaches every point-in-time restore of its
storage too. `durableObjectTenantKeys({ storage })` keeps each tenant's key, wrapped under the master
key, in a keeper: a Durable Object of its own, the class `createBoundaKeeper({ config })` returns,
one per tenant, in the [jurisdiction](#data-location) `storage` names:

```ts
// bounda.config.ts
import { cloudflare, durableObjectForgetLedger, durableObjectTenantKeys } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

const storage = cloudflare({ jurisdiction: "eu" });

export default defineConfig({
  storage,
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" }),
      tenantKeys: durableObjectTenantKeys({ storage }),
      forgetLedger: { store: durableObjectForgetLedger({ storage }) },
    },
  },
});
```

```ts
// src/worker.ts
import { createBoundaKeeper, createBoundaObject } from "@bounda-dev/cloudflare";

export class Store extends createBoundaObject({ registry, config }) {}
export class Keeper extends createBoundaKeeper({ config }) {}
```

```jsonc
// wrangler.jsonc
"durable_objects": {
  "bindings": [
    { "name": "STORE", "class_name": "Store" },
    { "name": "KEEPER", "class_name": "Keeper" }
  ]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store", "Keeper"] }]
```

`KEEPER` is the binding both stores reach unless `binding` names another. An object whose `env`
lacks it fails to start with a `ConfigurationError` that names it. Each tenant's record is a row in
its keeper's SQLite, written under compare-and-set, beside the forget ledger's entries, in the
tables of a tenant key store and a forget ledger [an adapter creates](/adapters/#what-an-adapter-creates);
one more keeper, the directory, lists the tenants with a record in `bounda_keeper_tenants`, which a
[rotation of the master key](#rotating-the-master-key) goes through.
Restoring a tenant's object leaves its keeper as it was. A keeper checks where it was created as a
tenant's object does, and refuses every call outside the jurisdiction its store is kept in, or for a
tenant other than its own. A store may keep its keepers in
[another jurisdiction](#keepers-in-another-jurisdiction) under a safeguard.

`kvTenantKeys({ binding })` keeps the records in a Workers KV namespace instead, one key each
under `bounda/tenant-keys/` and the tenant's name, for an app whose `cloudflare()` names no
jurisdiction: KV is cached outside any jurisdiction, so with one the app refuses to start on it,
unless it declares where it may keep the records with a safeguard (see [data
location](#data-location)). Bind it under `kv_namespaces`; `wrangler deploy` creates the
namespace when the binding has no id. KV has no compare-and-set; each tenant's record is written by
its own object alone, one at a time, so none is needed. `prefix` keeps the records under another
root, for two apps on one namespace.

The object answers `freezeTenant` and `unfreezeTenant`, which
[freeze](/guides/personal-data/#freezing-a-tenant) it, its alarm unarmed until the freeze is
lifted, `exportTenant`, which [hands the tenant back](/guides/personal-data/#handing-a-tenant-back)
before it is forgotten, `forgetTenant`, `rotateTenantKey`, its `reseal` included, and
`retireTenantKeys` through its stub, and `connect(stub)` types them; once forgotten, every call
rejects with `TenantForgottenError`, which `createWorker` answers with `410`. Once its recipients
are told, the object empties its storage with `deleteAll()` and holds nothing but the forgetting;
Cloudflare keeps the storage's point-in-time history for
[30 days](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), where what
was not sealed under the tenant's key, a read model's column
[in the clear](/guides/personal-data/#in-the-clear), stays until then. A keeper's history is kept as
long, and Bounda never restores one: a keeper restored by hand to before a forgetting brings the
tenant's key back, which, with the tenant's object restored too, opens its data again until that
history ages out.

## The forget ledger

Cloudflare restores a Durable Object's storage to a point in time, which brings back the keys of
everyone forgotten after it. `durableObjectForgetLedger({ storage })` keeps the record of every
forgetting in the tenant's keeper, outside its object and in the same jurisdiction, and an object
that starts forgets again whoever its restored storage brought back; restoring the storage restarts
the object. A read sees every write at once, and with `keepFor` the keeper removes each entry once
past it on its own alarm, whether the tenant's object is awake or not. The periodic reconciliation
never wakes an object on its own. Every
forgetting writes its intention to the keeper before the object commits it, so one the object did
not get to commit, because it was evicted or its transaction failed, is committed at its next start;
with `strict`, a forgetting the keeper does not take fails and forgets nobody. Once a [forgotten
tenant](/guides/personal-data/#forgetting-a-tenant)'s recipients are all told, its object has the
keeper remove every entry and mark of its ledger, and the alarm with them, before it empties its
own storage; the keeper keeps the tenant's key record, which records the forgetting. The ledger's
[fence](/guides/personal-data/#freezing-a-tenant) is a row in the keeper, which checks it in the
same transaction as every append and raised mark, so a freeze or a forgetting refuses them from
any object at once. See [backups](/guides/personal-data/#backups).

`kvForgetLedger({ binding })` keeps it in a KV namespace instead, for an app whose `cloudflare()`
names no jurisdiction. An object whose `env` lacks the binding fails to start with a
`ConfigurationError`. Each object keeps its entries under its tenant, its name or, for one reached
through an id without a name, the id, and reads the ledger once more a minute after it starts,
or after it finds a restore, since KV may take that long to list a key. With `keepFor` each key expires in KV by itself; `bounda forget-ledger expire` gives
the keys written before `keepFor` was set theirs. An entry lives in its key's metadata, which KV
caps at 1024 bytes; the categories and keys of a forgetting with too many to fit there, some
thirty, go to the key's value, which a read fetches for the entries it hands out alone, and
`bounda forget-ledger expire` writes back as it was, leaving alone a key gone meanwhile. An
intention has a key of its own, which its committed copy removes once it landed, so no write looks
at what another wrote: KV may not show it yet where an object runs, and an intention written there
after its committed copy still reads committed. An intention whose put was given up for the
ledger's timeout and landed after its committed copy is removed by the next read that lists both,
behind the fence, as any write. Each raise of a mark writes a key of its own, its value and the
time it was raised at, so a mark never goes down whatever the raise read, and the runtime tells a
value raised before the object started, which a listing may show a minute late, from one raised
since: a restore of the object's storage is counted at its start when the listing shows the marks
that tell it, and otherwise a minute later, never twice (see
[restores](/guides/personal-data/#restores)). Each start removes the values raised more than a
minute before it but the highest of them, once it compared them, and an object that compared every
mark does so once a minute: a listing of a mark reads the values of the last few minutes, a key
for each move of the generation and each start, however long the object runs and however often it
restarts. A
forgotten tenant's object deletes its keys once its recipients are told and a minute has passed
since the forgetting, waking for it, so every key written before is listed; KV deletes one key a
call, so each wake deletes a batch within the operations one invocation may make, and a larger
ledger is cleared over several wakes, each going on from what the last one left. KV cannot check
one key in the same step as it writes another, so its
[fence](/guides/personal-data/#freezing-a-tenant), a key of its own a clear leaves, is kept by the
tenant's object, the one writer of its ledger: it refuses an append or a raised mark under the fence
it set or the one KV holds, and waits for the ones under way before a fence it sets is in force.
`freezeTenant` waits the minute KV may take to list a key before it commits what the ledger holds,
so a freeze takes that long on KV.

## Rotating the master key

A rotation of the [master key](/guides/personal-data/#rotating-the-master-key) rewraps each
tenant's key in the tenant key store, and on Cloudflare the tenant's own object does it: an object
that sleeps through the rotation would keep its key under the previous master key. The `scheduled` of `createWorker` reaches them: it lists the tenants of the
store still under a previous master key and calls `wake()` on each one's object, which arms its
alarm at once and rewraps its record there. Give the Worker a cron trigger while a rotation is under
way:

```jsonc
// wrangler.jsonc
"triggers": { "crons": ["*/30 * * * *"] }
```

A Worker of your own exports `scheduled` the same way, from the handler `createWorker` returns.
Each run logs how many it woke, and how many failed to wake, each named in its own error line;
remove `previous` once a run logs `bounda worker found no tenant left under a previous master
key`.

## One object per tenant

`createWorker` addresses the object by the tenant `tenantOf` names for each request: in the
project above, the `x-bounda-tenant` header, `default` without it; an empty name reaches no
object and answers a 500, logged. Each tenant is its own object,
with its own events, read models and key, and nothing is shared between them. That is also how a
Cloudflare app scales: one object handles in the order of a thousand requests a second, and
[How Bounda runs](/concepts/how-it-runs/) explains why the way out is more stores, not a split
global stream.

## Data location

`cloudflare({ jurisdiction })` names the
[jurisdiction](https://developers.cloudflare.com/durable-objects/reference/data-location/) every
tenant's object is created in, `"eu"`, `"us"`, `"fedramp"` or `"fedramp-high"`, any other refused
with a `ConfigurationError`: Cloudflare then runs it and keeps its SQLite only
there, whichever part of the world its requests come from. It is the one place that says so, and
everything that reaches an object follows it: `createWorker`, the React Router hosts, and, for a
Worker of your own, `tenantStub({ config, env, tenant })`, or `boundaNamespace({ config, env })`
resolved once where the Worker starts. The same name in two jurisdictions
is two objects, so a tenant reached in another, by `env.STORE.idFromName` written by hand, say,
would have its data split between them; the object checks where it was created before it stores
anything, and one created in another jurisdiction than the configuration's, or in one when the
configuration names none, refuses to start with a `ConfigurationError`.

- Choose before the first deploy. An object never moves: with a jurisdiction added later, every
  tenant is reached in a new, empty object, and its data stays in the old one. With
  [tenant keys](#tenant-keys), the new object refuses to start instead, since the tenant's key
  belongs to the old one.
- A read model that `readModels` puts on `cloudflare()` lives in the tenant's object, so its
  `cloudflare()` names the same jurisdiction as `storage`, or none when `storage` names none. The
  app refuses to start on one that names another, and so does `bounda personal-data inventory`.
- The jurisdiction is the app's [location](/reference/configuration/#data-location), compared with
  every other by the legal regime it is under: `"eu"` the European Economic Area, `"us"`,
  `"fedramp"` and `"fedramp-high"` the United States. A read model on another adapter, such as a
  PostgreSQL server or a Turso database, declares the same with `location: "eu"`, or another under
  the same regime, such as `"de"`, and so does the key wrapper, `masterKey({ from, location: "eu" })` or a KMS
  through `defineKeyWrapper`, or the app refuses to start on it, and so does the record of
  processing. The object checks its own jurisdiction, but Bounda cannot see where Cloudflare
  keeps a Worker's secrets: where the master key in `BOUNDA_MASTER_KEY` is kept is yours to
  answer for, as with any declared location.
- `workerd` has no jurisdictions where it runs locally, under `wrangler dev`, `vite dev` and the
  tests: there every object stays on your machine and the setting is ignored.
- The jurisdiction holds the objects, not the Worker in front of them, which runs near each
  request. [Tenant keys](#tenant-keys) and the [forget ledger](#the-forget-ledger), wrapped keys
  and the ids of persons, are held to it too: with a jurisdiction, the app refuses to start on a
  tenant key store or a forget ledger whose `location` is under another legal regime, unless it
  declares a [safeguard](#keepers-in-another-jurisdiction) for the one it names, and so does
  `bounda personal-data inventory`. The keeper's, `durableObjectTenantKeys({ storage })` and
  `durableObjectForgetLedger({ storage })`, are in it. Workers KV is not: its
  [compatibility table](https://developers.cloudflare.com/data-localization/compatibility/) says
  jurisdictional restrictions for KV pairs are not supported today, and even a namespace created in
  a [jurisdiction](https://developers.cloudflare.com/kv/reference/data-location/) is cached
  outside it, so `kvTenantKeys` and `kvForgetLedger` declare no location and are refused. A store
  of your own declares its place through `defineTenantKeyStore(create, { location: "eu" })` or
  `defineForgetLedger(create, { location })`, which you then answer for.
- [`bounda personal-data inventory`](/reference/cli/#bounda-personal-data-inventory) says where
  each holder and store is kept: `cloudflare, in eu`. Without a jurisdiction it lists the storage,
  and every store that declares no location, as findings.

### Keepers in another jurisdiction

`durableObjectTenantKeys` and `durableObjectForgetLedger` take a **`jurisdiction`** of their own,
with the **`safeguard`** that allows keeping the store there, one of articles 45 to 47 as for any
[store in another jurisdiction](/reference/configuration/#stores-in-another-jurisdiction). Here the
objects are in the EU and the tenants' keys in the US, under the EU-US Data Privacy Framework's
adequacy decision:

```ts
const storage = cloudflare({ jurisdiction: "eu" });

export default defineConfig({
  storage,
  runtime: {
    personalData: {
      keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY", location: "eu" }),
      tenantKeys: durableObjectTenantKeys({ storage, jurisdiction: "us", safeguard: "adequacy" }),
      forgetLedger: { store: durableObjectForgetLedger({ storage }) },
    },
  },
});
```

- Each store's keepers are created in its jurisdiction and never leave it; a keeper refuses each
  store's calls outside that store's, so a tenant whose key and ledger are kept apart has a keeper
  in each, both through the one `KEEPER` binding. The types take a `safeguard` only beside a
  `jurisdiction`; without one, the keepers are in `storage`'s.
- The app refuses to start on a keeper under another legal regime without a safeguard, and on one
  under `storage`'s with a safeguard, which is no transfer: keepers in `"fedramp"` under objects in
  `"us"` take none, since both are in the United States. Choose before the first keeper exists, as
  for the objects: a tenant whose key is reached in a new jurisdiction finds none.
- Workers KV holds to no jurisdiction, so `kvTenantKeys` and `kvForgetLedger` take a `location`
  only together with a `safeguard`, and that location is `"global"`, anywhere in the world:
  `kvTenantKeys({ binding, location: "global", safeguard: "standard-contractual-clauses" })`. Any
  other location is refused, and so is `adequacy`, which no decision gives for anywhere.
- `bounda personal-data inventory` states the transfer next to the store, by the legal regime it
  goes to, `tenant-keys, in us, transferred to US under adequacy (article 45)`, and each
  person's export lists it in `transfers`, with its `location` and its `regime`.

`create-bounda` writes `jurisdiction: "eu"`: Bounda's defaults favour personal data staying in
the European Union, and an object placed elsewhere cannot be moved later. Take it out for an
audience far from Europe, before the first deploy.

## The HTTP API

`createWorker({ config, tenantOf })` serves one app as JSON, through the Durable Object binding
`cloudflare()` names, `STORE` unless `cloudflare({ binding })` says otherwise, and in its
[jurisdiction](#data-location).

| Request | Answer |
| --- | --- |
| `POST /commands/<name>` with the payload as the body | The dispatch result, once the read models reflect it, or once its events are stored with `createWorker({ config, tenantOf, consistency: "eventual" })`. `?delay=10m` schedules it |
| `POST /queries/<name>` with the payload as the body | The query's result |

Refusals come back as `{ "error": { "code", "message" } }` with the statuses in
[errors over HTTP](/reference/errors/#over-http); anything else is a 500 whose message goes to the
logs, not to the caller, under the rule of [error text](/reference/observability/#error-text). A body over `maxPayloadBytes`, `DEFAULT_MAX_PAYLOAD_BYTES` unless
`createWorker({ config, tenantOf, maxPayloadBytes })` says otherwise, is refused with a 413
before it is read.

Every request it refuses before an object serves it is recorded in the [host
log](/guides/personal-data/#refused-requests) before the answer goes out: a path that names no
route, a method other than `POST`, a body too large or not JSON, a `tenantOf` that throws or names
no tenant, an `actorOf` that throws or names an actor `as` refuses. It names the tenant and the
actor once they are known, which is why `tenantOf` and `actorOf` run before the body is read, and
must leave it unread, and
`commands/<name>` or `queries/<name>`, never the path. The records go to `onHostRejection` in the
`app/audit.ts` of the `registry` it takes, the one its objects run, and to its `logger` without
one. What an object refuses, a command or query it does not know, an actor `as` refuses over RPC,
a call its forgotten or frozen tenant refuses, the object records itself, and the Worker does not
record it again.

It has **no authentication** and no operator endpoint, on purpose: it is a starting point. For
the same reason it never [forgets](/guides/personal-data/) anyone, which cannot be undone, nor
restricts anyone's processing. An app with users writes its own `fetch` and talks to a store with
`connect`, whose `forget`, `restrict` and `unrestrict` it calls behind its own authentication.
`tenantStub` reaches the tenant's object as `createWorker` does, through the binding and in the
jurisdiction the configuration names:

```ts
import { connect, tenantStub } from "@bounda-dev/cloudflare";
import config from "../bounda.config.ts";

export default {
  async fetch(request, env) {
    const tenant = await tenantOfUser(request); // your authentication
    const store = connect(tenantStub({ config, env, tenant }));
    await store.commands.placeOrder({ orderId, customerId, total });
    return Response.json(await store.queries.listOrders({ customerId }));
  },
} satisfies ExportedHandler<Env>;
```

`connect(stub)` gives a `BoundaClient`, the type `@bounda-dev/core` gives to what a request sees
of an app wherever it runs: the same `commands` and `queries` as `app.commands` and
`app.queries`, typed from your modules, plus `getLag()`, `status()`, `events`, `deadLetters`,
`subscriberFailures`, `rebuildReadModel`, `forget`, `exportPersonalData`, `streamPersonalData`,
`restrict`, `unrestrict`, `freezeTenant`, `unfreezeTenant` and `exportTenant`. `streamPersonalData` and `exportTenant` cross RPC as a
stream of the export's parts, one JSON per line, read on the object a page at a time as the Worker
reads them, and stopped when the Worker stops reading, so a person's long history, or a whole
tenant, never has to fit in one RPC answer. `bounda status` runs where Node can open the store, so a Durable Object's is read
through `status()`, from an admin route of the Worker, say. A part the object cannot read comes
back marked `{ unreadable: true }` rather than failing the call, as on any host
([observability](/reference/observability/)): check `unreadableParts(status)` before answering it
as complete.
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
const store = connect(tenantStub({ config, env, tenant })).as(user.id);
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
value. An `actorOf` that throws, as one does for a request it cannot authenticate, gets a 500 too.
Each is recorded in the [host log](/guides/personal-data/#refused-requests), `actor-invalid` or
`actor-unresolved`, without the actor.

## Testing

The tests run inside `workerd` through
[`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
on the same Vitest as a Node project. `tests/orders.test.ts` runs the domain on the in-memory
adapter with `createTestApp`, as in any Bounda project; `tests/api.test.ts` sends requests to
the Worker with `SELF.fetch` and reaches the real Durable Object and its SQLite. The adapter's own
suite runs every storage contract inside `workerd` too.

`witnessObjects` from `@bounda-dev/cloudflare/testing` gives the objects of the class opened from
then on a witness, which records what each object's app seals, keeps, logs and traces and what the
object logs itself, each object's persons apart, and what the `hosts` in front log: the Worker
`createWorker` returns, or what `createBounda` from `@bounda-dev/react-router/cloudflare` returns.
Inside the object, with `runInDurableObject`, `expectForgotten`, `expectRedacted` and
`expectTenantForgotten` take the object and search its SQLite, the forget ledger its app keeps, in
KV or elsewhere, its logs, the hosts' and its spans, with nothing passed by hand:

```ts
import { env, runInDurableObject } from "cloudflare:test";
import { connect, tenantStub } from "@bounda-dev/cloudflare";
import { witnessObjects } from "@bounda-dev/cloudflare/testing";
import { expectForgotten } from "@bounda-dev/core/testing";
import config from "../bounda.config.ts";
import worker, { Store } from "../src/worker.ts";

witnessObjects(Store, { hosts: [worker] });

const stub = tenantStub<Store>({ config, env, tenant: "forgets" });
const store = connect(stub);
// ...
await store.forget("ada");
await runInDurableObject(stub, (object) => expectForgotten(object, "ada"));
```

Call `witnessObjects` at the top of the test file, before any object of the class opens: an object
opened before has no witness, and the expectations refuse it. An object that opens again, once
its storage is emptied or after it was evicted, keeps what the witness saw of it. A Worker with a
`fetch` of its own logs through `hostLogger(worker, logger)` from `@bounda-dev/cloudflare`, which
`witnessObjects` then reaches as it reaches `createWorker`'s. Without one, pass
`expectForgotten` the object's storage through `durableObjectAdapter`, with the options the
configuration gives `cloudflare()`, `tablePrefix` among them, and the values to look for.

Types for the bindings come from `wrangler types`, which writes `worker-configuration.d.ts` from
`wrangler.jsonc`; `dev`, `typecheck` and `check` run it, and `tsconfig.json` lists that file
instead of `@cloudflare/workers-types`. There is no `prepare` script: every script runs
`bounda generate` itself, and `npm install --package-lock-only` stays possible without
`node_modules`.

## Limits worth knowing

- **One object lives in one region**, inside its [jurisdiction](#data-location) when the
  configuration names one. Users far from it pay the latency on every command.
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
  An event that no read model, policy or process handles costs only its own rows: every
  subscriber [rests](/concepts/how-it-runs/) on it and the object arms no alarm for it, until a
  whole batch of such events is waiting and one alarm moves the checkpoints past them in one write
  each. A [snapshot](/concepts/long-streams/#snapshots) subscriber likewise wakes the object only
  for the event that brings a snapshot. Telling a subscriber at rest from one behind costs reads:
  `getLag()`, which the object also asks before arming its alarm, reads the events after each
  checkpoint, less than one batch, once per distinct checkpoint. A row read costs a thousandth of a
  row written, but a health check that calls `getLag()` every few seconds pays it on every call.
  A checkpoint it cannot read leaves `maxLag` `null`, and the object then tries again a retry
  interval later, as for a rebuild slice that failed, still waking at once for the new events of
  the other subscribers.
  Each policy or process reaction adds its own writes, and the alarm that runs it is one more
  request. A scheduled command, dead letter, snapshot or remembered rejection that holds personal
  data writes two more rows for each person it names, and as many again when it goes: the entry
  in the table that finds it by person for `forget` and the export, and that entry's index. `"eventual"` consistency saves nothing: in an app without policies or processes each
  command then arms the alarm, which Cloudflare bills as one more row written, and the alarm that
  projects is one more request; with them, the alarm runs after each command anyway and projects
  in the same request. What it buys is a command that answers sooner. On the paid plan the first
  fifty million row writes a month are included, and a million commands beyond that cost around
  eight dollars.
