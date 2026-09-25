---
title: How Bounda runs, and how far it scales
description: One ordered log per store, one writer at a time, subscribers with checkpoints. What that buys, what it costs, and what to do when you hit the ceiling.
sidebar:
  order: 8
---

This page is for the moment before you adopt Bounda, or the moment someone asks "does this
scale?". It says how the runtime moves events around, why it was built that way, where the
ceiling is with numbers, and what the way out is. Nothing here is hidden elsewhere in the docs;
this is the one place that puts it together.

## One log per store

Every event a store holds has a `position` in a **single global order**, whatever aggregate it
belongs to. Commands append to an aggregate's stream and the store gives each event the next
global position at commit. Everything on the read side, projections, the policy runner and the
process runner, is a **subscriber** of that log: it keeps one checkpoint, asks the store for the
events after it, and moves the checkpoint once a batch is done. The policy runner and the process
runner exist only when the app has a policy or a process. That is the whole delivery mechanism, and it is what a Durable Object, a PostgreSQL schema or a SQLite file each hold: a
complete store.

Handlers are declared per aggregate: a policy lives under `app/domain/order/policies/`, and its
types come from that aggregate's events. But it is **fed from the log**, not from the aggregate.
The distinction matters for everything below.

<figure>
  <img
    src="/flow-light.svg"
    alt="The app sends commands to command handlers in the domain, which decide from the state apply folds from the aggregate's own stream and return events for the event store, one ordered log. After commit, and asynchronously, policies and processes in the domain follow the log and send new commands, and projections turn events into rows in tables, in the same database or their own. Query handlers read those rows to answer the app's queries"
    class="dark:sl-hidden"
  />
  <img
    src="/flow-dark.svg"
    alt="The app sends commands to command handlers in the domain, which decide from the state apply folds from the aggregate's own stream and return events for the event store, one ordered log. After commit, and asynchronously, policies and processes in the domain follow the log and send new commands, and projections turn events into rows in tables, in the same database or their own. Query handlers read those rows to answer the app's queries"
    class="light:sl-hidden"
  />
</figure>

## Why a single order

- **Read models cross aggregates.** A table of orders per customer needs `CustomerRegistered`
  from `customer` and `OrderPlaced` from `order`. With one ordered log the projection always sees
  the customer before the order. Without it, the order can arrive first and the row is half built
  until something repairs it. Most event-sourcing systems make the same choice for the same
  reason: EventStoreDB's `$all`, Marten's global sequence, Axon's token store.
- **One checkpoint per read model**, not one per aggregate instance. With a hundred thousand
  orders, a reader per stream would be a hundred thousand checkpoints per read model.
- **Operations hang off it.** `app.getLag()` is "head of the log minus checkpoint".
  [`bounda rebuild`](/guides/deployment/#rebuilding-a-read-model) is "project the log again
  into a fresh table". `processUntilIdle()` is "pass until nobody moves". The checkpoint is
  advanced with a compare-and-set, so nothing written from outside is ever overwritten.

## The ceiling, with numbers

A single order means **one writer at a time per store**. In PostgreSQL every append takes a
transaction-scoped advisory lock; in SQLite the engine is a single writer anyway. Throughput is
bounded by what one connection can commit: **thousands of events per second** on ordinary
hardware.

To put that against a business: a shop that takes a thousand orders a day and emits five events
per order produces five thousand events a day, one every seventeen seconds. The ceiling is three
to four orders of magnitude away. An app that fills it is an app with a very good problem.

Reads are not bounded the same way. Queries hit read-model tables like any other tables, and the
dispatcher reads the log in batches of `batchSize` events per pass, so a store with many read
models costs one indexed range scan per read model per pass, not one per event.

## The way out: one store per tenant

When one store is not enough, do not split the log. **Split the store.** A store per tenant, per
region or per bounded context, each with its own ordered log:

```ts
// bounda.config.ts
const tenant = process.env.TENANT!;

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL!, schema: `tenant_${tenant}` }),
});
```

Each tenant's process boots against its own schema and gets its own ceiling. The cost is the one
every partitioned system pays: a read model that spans tenants has to merge, and that is
analytics, not operation. If a single tenant ever fills a store on its own, the known evolution is
partitioning the log by aggregate id with a position per partition, at the price of ordering
across partitions. It is not built, because nobody needs it yet, and it fits the model without
changing how you write modules.

## What more instances do, and do not do

Run several worker instances on PostgreSQL and each policy and process handler runs on **one
instance per event**: the inbox ledger claims `(handler, event)` atomically, so instances share
that work and add throughput for reactions. Delivery is still at least once: a handler that crashes
midway runs again ([what the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises)).

Projections go further: they are applied **exactly once**, and one instance at a time per read
model. Each batch runs in one transaction on the read model's database, holding a lock named after
it: PostgreSQL's `pg_advisory_xact_lock`, SQLite's single writer, the Durable Object's transaction.
The rows the batch writes and the checkpoint past it commit together or roll back together, so a
crash, a projection that throws halfway or a second instance can neither apply an event twice nor
put an older batch over a newer one. An instance that finds a read model locked skips it and moves
on to the next, so different read models spread over the instances, while one read model always
advances in order on one of them at a time. More instances buy **availability**, and speed when
there are several read models to share out; they do not make a single read model faster, because
its events have to be applied in order. If one read model ever falls behind, the lag gauge tells
you, and the fix is a faster projection or a lighter read model.

The guarantee holds for what the projection writes through `table` and `client`, `client.raw`
included, since inside a batch it is the driver's transaction handle. Anything a projection does
outside its read model, an HTTP call or another database, is not part of the transaction: it would
run again with a batch that is retried, which is why it belongs in a policy.

## Why there is no broker

Bounda's promise is that one database is all your infrastructure, and a broker does not earn its
place inside the app:

- The log **is** the broker's job, done better for this purpose: ordered, replayable, with random
  access by aggregate for commands. A broker as the event store loses optimistic concurrency per
  stream and access by id, and a queue without replay loses rebuilds altogether.
- A broker between the store and the projections would spread projection work across instances,
  at the price of a component to operate, at-least-once redelivery and ordering only within a
  partition. A lock per read model in the database already spreads that work, with nothing new
  to run.

Where a broker does belong is **outside the app**: when events have to reach another service, a
warehouse or a company-wide Kafka. The piece for that is a publisher, which is just one more
subscriber of the log: read from its checkpoint, publish, advance when the broker confirms. It is
the outbox pattern without an outbox table, because the log already is one. It is not built yet;
when it is, it will be a subscriber, not a change to the model.

## In one paragraph

A store is one ordered log with one writer at a time and subscribers that keep checkpoints. That
buys cross-aggregate order for read models and makes lag, rebuild and replay trivial. It costs a
ceiling of thousands of events per second per store, which you raise by running one store per
tenant. Instances share reactions and spread read models, each applied exactly once. Brokers stay
outside, as publishers.
