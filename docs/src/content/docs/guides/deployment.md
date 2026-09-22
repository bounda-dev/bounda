---
title: Deployment
description: Roles, one database, many instances, and an honest list of what is not there yet.
sidebar:
  order: 6
---

A Bounda app is a Node process with a database. There is no broker, no scheduler and no separate
projector to deploy: the runtime does that work inside the process, and which part of it a process
does is a matter of configuration.

## Booting

`boot()` loads `.env`, the configuration and the generated registry, and returns the app. It does
**not** start background work:

```ts
import { boot } from "@bounda-dev/core/node";

const app = await boot();
app.start();
```

`start()` starts the dispatcher — projections, policies and processes — and the worker that runs
due scheduled commands. `boot()` installs `SIGINT` and `SIGTERM` handlers by default, so a
container stop drains passes in flight and closes connections; pass `signals: false` to handle
that yourself, as a script would.

## Roles

`runtime.role` decides what a process does. The default is `all`, which is one process doing
everything — the right answer until it is not.

| Role | What `start()` does |
| --- | --- |
| `all` (default) | runs the dispatcher and the scheduled command worker |
| `web` | nothing |
| `worker` | runs the dispatcher and the scheduled command worker |

Serving HTTP is your app's business, not Bounda's: the role only decides whether this process also
does the background work. `web` and `worker` differ in that alone, and the names are there to make
a deployment readable.

```ts
import { postgresql } from "@bounda-dev/adapter-postgresql";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  runtime: { role: process.env.BOUNDA_ROLE === "worker" ? "worker" : "web" },
});
```

Splitting them means a slow policy cannot compete with request handling for the event loop, and
the two scale separately. Commands still work in `web`: dispatching stores events, and the worker
picks up their consequences.

`processUntilIdle()` and `catchUpReadModels()` work in every role, which is what makes a `web`
process able to wait for its own writes without running the background loop.

## More than one instance

Use PostgreSQL. SQLite is a single writer and fine for one process; PostgreSQL is what the
adapter's concurrency work is for. Handler claims are single `INSERT … ON CONFLICT` statements and
due scheduled commands are taken `FOR UPDATE SKIP LOCKED`, so any number of instances can run the
worker role and each event and each due command is handled by exactly one of them.

Appends take a transaction-scoped advisory lock, so positions in the global stream are handed out
in commit order and a reader never sees a gap that a later commit would fill. That bounds write
throughput to what one connection can commit — thousands of events per second.

Nothing needs to be told about the others: instances coordinate through the database.

## Reading your own writes

After a command returns, its events are stored but the read models have not caught up. A request
that writes and then renders needs to wait for the projections it is about to read:

```ts
import { readYourWrites } from "@bounda-dev/core";

const consistent = readYourWrites(app);
await consistent.commands.placeOrder({ orderId, customerId, total });
// a query here already sees the order
```

`readYourWrites` returns the same app with a `commands` facade that brings the read models up to
date before resolving. A scheduled command resolves immediately, since there is nothing to catch
up to yet, and commands dispatched from inside the runtime — by a policy or a process — are not
affected.

`app.catchUpReadModels()` is the primitive underneath: it runs the projections until every read
model reflects what is stored, and leaves policies, processes and scheduled commands to the
background.

In a React Router app this is a setting rather than a call — `createBounda({ consistency })`,
`"immediate"` by default. See [Bounda with React Router](/guides/react-router/).

## Schema

The adapter creates what it needs on start: the event store, the ledgers and a table per read
model. Adding a field to a view adds a nullable column the next time the app starts and existing
rows keep working. Removing a field or changing its type is refused with an error naming the read
model — rename the read model instead and it is built from scratch.

There are no migration files to run, and no migration step in your deploy.

## Tuning

The dispatcher polls. `pollInterval` is 100 ms and `batchSize` is 100 events per pass:

```ts
runtime: {
  dispatcher: { pollInterval: "50ms", batchSize: 500 },
}
```

A shorter interval cuts the delay before a policy reacts and costs queries; a larger batch moves
more events per pass and holds a claim for longer.

## What is not there yet

Bounda is alpha, and the honest list of what production would eventually want:

- **`LISTEN`/`NOTIFY`.** Instances discover events by polling, so a reaction is up to
  `pollInterval` behind. Notifications would make it immediate.
- **Snapshots.** An aggregate is rebuilt from its whole stream on every command. Fine for
  hundreds of events per instance, not for hundreds of thousands.
- **Upcasters.** Changing the shape of an event that is already stored has no supported path yet;
  today you add a new event type and keep handling the old one.
- **Rebuilding a read model in place.** Renaming it rebuilds it, which is enough to move forward
  but is not what you want against a large stream.
- **OpenTelemetry.** There is structured logging and `app.getLag()`; there are no traces or
  metrics exported.

None of these block a small app in production. All of them are the next phase of work, and the
list is here so that nobody discovers it the hard way.
