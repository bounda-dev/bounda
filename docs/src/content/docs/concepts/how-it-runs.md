---
title: How Bounda runs, and how far it scales
description: One event store and one global stream per store, one writer at a time, subscribers with checkpoints. What that buys, what it costs, and what to do when you hit the ceiling.
sidebar:
  order: 0
---

This page is for the moment before you adopt Bounda, or the moment someone asks "does this
scale?". It says how the runtime moves events around, why it was built that way, where the
ceiling is with numbers, and what the way out is. The pages after it in Concepts take each
decision further.

## One global stream per store

A **store** is the unit Bounda runs on: one database, one PostgreSQL schema or one Durable
Object, holding an event store and everything that hangs off it. Each aggregate instance has its
own **stream** of events, and every event the store holds also has a `position` in a single
**global stream**, whatever aggregate it belongs to. Commands append to an aggregate's stream and
the store gives each event the next global position at commit.

Everything on the read side, projections, the policy runner and the process runner, is a
**subscriber** of the global stream: it keeps one checkpoint, asks the store for the events after
it, and moves the checkpoint past what it has finished. That is the whole delivery mechanism. The
policy runner and the process runner exist only when the app has a policy or a process.

Handlers are declared per aggregate: a policy lives under `app/domain/order/policies/`, and its
types come from that aggregate's events. But it is **fed from the global stream**, not from the
aggregate. The distinction matters for everything below.

<figure class="bounda-ledger">
  <table>
    <thead>
      <tr><th scope="col">Position</th><th scope="col">Stream</th><th scope="col">Event</th><th scope="col">Checkpoint</th></tr>
    </thead>
    <tbody>
      <tr><td>004 207</td><td>customer/ada</td><td>CustomerRegistered</td><td></td></tr>
      <tr><td>004 208</td><td>order/7f3a</td><td>OrderPlaced</td><td></td></tr>
      <tr><td>004 209</td><td>payment/91c0</td><td>PaymentRequested</td><td>policies</td></tr>
      <tr><td>004 210</td><td>order/7f3a</td><td>OrderPaid</td><td>processes</td></tr>
      <tr><td>004 211</td><td>order/b2e1</td><td>OrderPlaced</td><td></td></tr>
      <tr class="head"><td>004 212</td><td>payment/91c0</td><td>PaymentSettled</td><td>projection:<wbr />orders</td></tr>
    </tbody>
  </table>
  <figcaption>
    The events of three aggregates in one global order, as they were committed. Each subscriber
    has read up to its checkpoint; the projection is at the head. The next event enters at the end.
  </figcaption>
</figure>

## Why a single order

- **Read models cross aggregates.** A table of orders per customer needs `CustomerRegistered`
  from `customer` and `OrderPlaced` from `order`. With one global stream the projection always
  sees the customer before the order. Without it, the order can arrive first and the row is half
  built until something repairs it. Most event-sourcing systems make the same choice for the same
  reason: EventStoreDB's `$all`, Marten's global sequence, Axon's token store.
- **One checkpoint per read model**, not one per aggregate instance. With a hundred thousand
  orders, a reader per stream would be a hundred thousand checkpoints per read model.
- **Operations hang off it.** `app.getLag()` is "head of the global stream minus checkpoint".
  [`bounda rebuild`](/guides/deployment/#rebuilding-a-read-model) is "project the global stream
  again into a fresh table". `runUntilIdle()` is "pass until nobody moves". The checkpoint is
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
dispatcher reads the global stream in batches of `batchSize` events per pass, so a store with many
read models costs one indexed range scan per read model per pass, not one per event.

## The way out: one store per tenant

When one store is not enough, do not split the global stream. **Split the store.** A store per
tenant, per region or per bounded context, each with its own event store and global stream:

```ts
// bounda.config.ts
const tenant = process.env.TENANT!;

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL!, schema: `tenant_${tenant}` }),
});
```

Each tenant's process boots against its own schema and gets its own ceiling; on Cloudflare each
tenant is its own Durable Object. The cost is the one every partitioned system pays: a read model
that spans tenants has to merge, and that is analytics, not operation.

If a single tenant ever fills a store on its own, the known evolution is several event stores per
app, partitioned by aggregate, with a position per partition. Akka works that way, ordering events
per entity with no global order. The price falls on the read side: a checkpoint per event store,
projections that tolerate events out of order across partitions, and rebuilds that may not match
what was seen live. It is not built, because nobody needs it yet, and it fits the model without
changing how you write modules.

## What more instances do

Several worker instances on PostgreSQL share reactions, one instance per run, and spread read
models, one instance per read model at a time
([what each instance does](/guides/deployment/#more-than-one-instance)). They add throughput for
reactions and availability for projections, but they do not make one read model faster, because its
events have to be applied in order: that is the ceiling of a single projection, as the single writer
is the ceiling of the store.
[At least once, and exactly once per batch](/concepts/delivery-guarantees/) says what each promise
covers and where it stops.

## No broker inside the app

Bounda's promise is that one database is all your infrastructure. The event store is already
ordered, replayable and readable by aggregate, so a broker between the writes and the read models
would add a component to operate, redelivery and ordering only within a partition, and buy nothing
a lock per read model does not already give. A broker belongs behind the event store, for events
that leave the app, as one more subscriber: see
[A broker goes behind the event store](/concepts/where-a-broker-goes/).

## In one paragraph

A store is one event store with one global stream, one writer at a time and subscribers that keep
checkpoints. That buys cross-aggregate order for read models and makes lag, rebuild and replay
trivial. It costs a ceiling of thousands of events per second per store, which you raise by
running one store per tenant. Instances share reactions, which run at least once with the inbox,
and spread read models, whose batches are applied exactly once. Brokers stay outside, as
publishers.
