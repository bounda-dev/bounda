---
title: Deployment
description: Roles, one database, many instances, rebuilds, observability, and an honest list of what is not there yet.
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

A host with no background loop at all, such as a serverless function or a Durable Object, drives
the same work in slices. `processUntilIdle({ maxPasses })` stops after that many rounds and
resolves to `{ idle }`, `false` when work is left; `app.nextDueAt()` is the earliest moment a
scheduled command or a process time-out becomes due, or `null`. Together they say when to come
back:

```ts
const { idle } = await app.processUntilIdle({ maxPasses: 20 });
const next = idle ? await app.nextDueAt() : new Date();
// arm a timer, an alarm or a cron trigger for `next`, if there is one
```

## More than one instance

Use PostgreSQL. SQLite is a single writer and fine for one process; PostgreSQL is what the
adapter's concurrency work is for. Handler claims are single `INSERT … ON CONFLICT` statements and
due scheduled commands are taken `FOR UPDATE SKIP LOCKED`, so any number of instances can run the
worker role and each policy or process handler and each due command runs on exactly one of them.

Projections are applied exactly once as well. Each batch runs in one transaction that holds an
advisory lock named after its read model, writes the rows and advances the checkpoint, so one
instance at a time applies a read model and a batch is never applied twice or over a newer one.
An instance that finds a read model locked skips it, which spreads different read models over the
workers; a single read model is not made faster by more of them, since its events apply in order.
[How Bounda runs](/guides/how-it-runs/) explains why, and what the ceiling of one store is.

Appends take a transaction-scoped advisory lock, so positions in the global stream are handed out
in commit order and a reader never sees a gap that a later commit would fill. That bounds write
throughput to what one connection can commit — thousands of events per second.

Checkpoints advance with a compare-and-set from the position a pass read, inside the batch's
transaction for projections. A pass that finds its subscriber's checkpoint moved by someone else,
an operator repositioning it or a rebuild, leaves that position alone and continues from there on
the next pass; for a projection the batch it had applied is rolled back with it, so nothing
written from outside is ever overwritten by work that was already in flight.

A read model configured on a database of its own, under `readModels` in the config, keeps its
checkpoint in that database, next to its rows, because a transaction cannot span two databases.

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
model — that is what `bounda rebuild` is for, below.

There are no migration files to run, and no migration step in your deploy.

## Rebuilding a read model

A read model is derived data: when its projection had a bug, or its view lost a field or changed a
field's type, the answer is to project the stream again. `bounda rebuild <read-model>` does that
without taking the read model offline:

1. It creates a fresh table with the view's current fields, next to the live one.
2. It runs the projections over the whole stream into that table. Queries keep reading the live
   table meanwhile, and the worker keeps projecting new events into it.
3. When the fresh table has caught up, it takes the live table's place and the read model's
   checkpoint is set to where the rebuild stopped, in one transaction that waits for the
   projection lock, so no batch is halfway through when it happens.

Whatever the worker had applied to the old table goes with it, and the worker carries on from the
rebuilt position, whether it was ahead of it or behind: every event reaches the new table exactly
once. A projection that throws aborts the rebuild and leaves the live table as it was.

```bash
bounda rebuild orderSummary
```

Run it from a machine with the new code and access to the database, before deploying that code:
the app refuses to start against a table whose columns no longer match the view. Between the
swap and the deploy, the old worker's projection for that read model may fail against the new
columns; its checkpoint holds, and it catches up as soon as the new code runs. Nothing is lost.

A rebuild that stops halfway, because the machine died or the connection dropped, resumes exactly
where it was the next time you run it: every batch commits together with the position it
reached, kept in the read model's database as a checkpoint named
`rebuild:<read model>:<fingerprint>`. The fingerprint is a digest of the view's fields and the
projections' code, so a rebuild left behind by different code starts again from a fresh table
instead of mixing rows projected by two versions.

Two things the rebuild cannot do for you. A projection that writes through `client` with SQL
naming the table by hand keeps writing to the live table, not to the fresh one — write projections
through `table`. And a read model with millions of events takes as long as projecting them takes;
watch the `read model rebuild progressed` log line.

Programmatically, `app.rebuildReadModel(name)` on an app, or `rebuildReadModel({ registry,
config, name })` from `@bounda-dev/core` on a project loaded with `loadProject()` from
`@bounda-dev/core/node`. Both take `maxEvents` to run one slice and pause: the result says
`done: false`, the next call resumes, and `app.pendingRebuilds()` lists the read models waiting
for one. That is how a host without a long-running process, such as a Durable Object, rebuilds a
stream that does not fit in one request.

## Tuning

The dispatcher runs passes on a timer: `pollInterval` is 100 ms and `batchSize` is 100 events
per pass.

```ts
runtime: {
  dispatcher: {
    pollInterval: "50ms",
    idleInterval: "1m",
    batchSize: 500,
    projectionBatchTime: "500ms",
  },
}
```

With PostgreSQL the timer is a safety net, not the mechanism. Every append ends its transaction
with `NOTIFY` on the events table's channel, delivered at commit, and every worker `LISTEN`s on
a dedicated connection: a pass runs the moment events land, and once passes stop finding events
the dispatcher waits `idleInterval`, 30 seconds by default, between polls. An idle worker on
PostgreSQL therefore costs a handful of queries a minute instead of ten passes a second per
subscriber, and a policy reacts in milliseconds. A notification lost to a dropped connection is
caught by the next idle poll, which is why the poll stays. The scheduled-command worker still
polls at `pollInterval`: due commands are a matter of time, not of new events.

SQLite and the in-memory adapter have no channel to listen on. SQLite polls at `pollInterval` as
before; the in-memory adapter notifies within the process, so a started app reacts to its own
appends without waiting for the timer.

A shorter `pollInterval` cuts the delay before a policy reacts where polling is the mechanism and
costs queries; a larger batch moves more events per pass and holds a claim for longer.

A projection batch keeps its transaction open for at most `projectionBatchTime`, 250 ms by
default: past it, the batch commits the events it got through and the rest are delivered next.
On SQLite that transaction holds the database's single writer, so commands wait for it; the limit
keeps that wait short however many events a batch carries. Rebuilds honour it too.

## Observability

The runtime is instrumented with the [OpenTelemetry API](https://opentelemetry.io/docs/languages/js/).
Without an SDK registered that costs nothing: the API hands out no-op spans and meters. Register
one and Bounda's spans and metrics show up next to your HTTP server's and your database
driver's, with no adapter to write:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
sdk.start();

const app = await boot(); // after the SDK, so its instruments bind to the provider
```

Everything is reported under the scope `@bounda-dev/core`. Spans:

| Span | When | Attributes |
| --- | --- | --- |
| `bounda.command <Type>` | a command is dispatched | `bounda.command.type`, `bounda.aggregate.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.causation_id`, `bounda.outcome` (`stored`, `scheduled`), `bounda.event.count` |
| `bounda.subscriber <name>` | the dispatcher hands a batch to a projection, the policy runner or the process runner; idle passes produce none | `bounda.subscriber`, `bounda.subscriber.kind`, `bounda.position.after`, `bounda.event.count`, `bounda.outcome` (`advanced`, `held`, `failed`, `moved`) |
| `bounda.projection <readModel>.<projection>` | a projection handles one event | `bounda.read_model`, `bounda.projection`, the event's id, type and aggregate, `bounda.correlation_id` |
| `bounda.policy <aggregate>.<policy>` | a policy handler runs | `bounda.policy`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt` |
| `bounda.process <aggregate>.<process>` | a process handler runs; `… timeout` for `on-timeout.ts` | `bounda.process`, the event's id, type and aggregate, `bounda.correlation_id`, `bounda.attempt` |
| `bounda.scheduled <Type>` | the worker runs a due command or a process timeout | `bounda.command.type`, `bounda.aggregate.id`, `bounda.correlation_id`, `bounda.attempt` |

A handler that throws marks its span as an error with the message and records the exception.

One request is not one trace. A policy runs in a later dispatcher pass, in whatever process picks
it up, so the command's span and the policy's span are separate traces. What ties them together is
`bounda.correlation_id`: the command, the events it stored, the policy that reacted and the
command it dispatched all carry the same value, so a search on that attribute shows the chain.

Metrics:

| Metric | Kind | Attributes |
| --- | --- | --- |
| `bounda.dispatcher.lag` | observable gauge, events each subscriber is behind the head | `bounda.subscriber` |
| `bounda.commands` | counter | `bounda.command.type`, `bounda.outcome` (`stored`, `scheduled`, `rejected`) |
| `bounda.dead_letters` | counter | `bounda.subscriber.kind`, `bounda.subscriber`, `bounda.outcome` (`terminal`, `retriable_exhausted`) |

The lag gauge is what to alert on: a subscriber whose lag grows is a projection or a policy that
is failing or stuck, and `app.getLag()` returns the same numbers for a health endpoint.

## On Cloudflare

A Cloudflare app has no process to run and no role to pick: a Worker answers requests and a
Durable Object per tenant holds the store. Commands update the read models before they answer;
policies, processes and scheduled commands run in the object's alarm. [The Cloudflare
adapter](/adapters/cloudflare/) covers it, limits and cost included.

## What is not there yet

Bounda is alpha, and this is the honest list of what a production app might want and does not
get today. Each item says why, so nobody discovers it the hard way:

- **Snapshots.** An aggregate is folded from its whole stream on every command. That is fine for
  the hundreds of events per instance that Bounda's kind of app produces, and it is not fine for
  hundreds of thousands. Snapshots are deliberately not built yet: the state is inferred and
  carries no version, so a snapshot written by yesterday's `apply` would silently be wrong after
  today's deploy. They come with a versioning story or not at all; until then, model long-lived
  things as processes, which close, rather than as aggregates that grow forever.
- **Changing the shape of a process's state.** A process keeps its state in its own lifecycle
  events, so a change to that shape has the same problem an event payload has, and no
  `state.upcast.ts` yet. See [Changing an event's shape](/guides/changing-events/#what-is-not-covered-yet).
- **Renaming or removing an event type.** Upcasts change a payload, not a type. Keep the module,
  even if `apply` returns the state unchanged.
- **One trace per request.** Spans carry `bounda.correlation_id` but a policy's span is a separate
  trace from the command's, because it runs in a later pass. See [Observability](#observability).
- **Notifications for scheduled commands.** The worker that runs due commands polls at
  `pollInterval`; only the event dispatcher is woken by `NOTIFY`. See [Tuning](#tuning).

What a production app does get, and where it is explained: [rebuilding a read model](#rebuilding-a-read-model)
without taking it offline, [dead letters with a way out](/guides/reacting-to-events/#dead-letters),
[upcasts](/guides/changing-events/) for events whose payload changed, [observability](#observability)
through OpenTelemetry, and a dispatcher that reacts in milliseconds on PostgreSQL.
