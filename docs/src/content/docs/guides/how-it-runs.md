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
events after it, and moves the checkpoint once a batch is done. That is the whole delivery
mechanism, and it is what a Durable Object, a PostgreSQL schema or a SQLite file each hold: a
complete store.

Handlers are declared per aggregate: a policy lives under `app/domain/order/policies/`, and its
types come from that aggregate's events. But it is **fed from the log**, not from the aggregate.
The distinction matters for everything below.

<figure>
  <img
    src="/flow-light.svg"
    alt="A command handler decides from state and returns events, the events are appended to the event store, which keeps them in one ordered log, and read models, policies and processes subscribe to that log while policies and processes dispatch new commands"
    class="dark:sl-hidden"
  />
  <img
    src="/flow-dark.svg"
    alt="A command handler decides from state and returns events, the events are appended to the event store, which keeps them in one ordered log, and read models, policies and processes subscribe to that log while policies and processes dispatch new commands"
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

Run several worker instances on PostgreSQL and every policy and process handler runs **exactly
once**: the inbox ledger claims `(handler, event)` atomically, so instances share that work and
add throughput for reactions.

Projections are different. Every instance reads the same batches and applies them, idempotently,
so a second instance does not make a read model catch up faster. More instances buy
**availability** for projections, not speed. The lag gauge tells you when a projection is behind;
if one ever is, the fix is a faster projection or a lighter read model, not another instance. The
known runtime improvement, leasing each subscriber to one instance so that read models are spread
across workers, is a bounded change to the dispatcher that will land when someone has that
problem.

## Why there is no broker

Bounda's promise is that one database is all your infrastructure, and a broker does not earn its
place inside the app:

- The log **is** the broker's job, done better for this purpose: ordered, replayable, with random
  access by aggregate for commands. A broker as the event store loses optimistic concurrency per
  stream and access by id, and a queue without replay loses rebuilds altogether.
- A broker between the store and the projections would spread projection work across instances,
  at the price of a component to operate, at-least-once redelivery and ordering only within a
  partition. Subscriber leases solve the same problem with nothing new to run.

Where a broker does belong is **outside the app**: when events have to reach another service, a
warehouse or a company-wide Kafka. The piece for that is a publisher, which is just one more
subscriber of the log: read from its checkpoint, publish, advance when the broker confirms. It is
the outbox pattern without an outbox table, because the log already is one. It is not built yet;
when it is, it will be a subscriber, not a change to the model.

## In one paragraph

A store is one ordered log with one writer at a time and subscribers that keep checkpoints. That
buys cross-aggregate order for read models and makes lag, rebuild and replay trivial. It costs a
ceiling of thousands of events per second per store, which you raise by running one store per
tenant. Instances share reactions but not projections. Brokers stay outside, as publishers.
