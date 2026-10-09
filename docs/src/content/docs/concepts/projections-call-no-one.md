---
title: Your projection should not call anyone
description: Why a Bounda projection receives no ports and writes only to a database that commits its rows with its checkpoint, where outside data goes instead, and why an external search index is a different kind of read model.
sidebar:
  order: 50
---

Sooner or later a projection wants something it does not have: the exchange rate of the day, a
geocode for an address, the avatar from the identity service. Or it wants to write somewhere
other than a table: a Redis cache, an Elasticsearch index. Both look like one more line in
`project`. Bounda does not allow either, on purpose. A projection receives the event, its
read model's `table` and `client`, and nothing else: **a projection is a function of the event
store into tables that commit together with its checkpoint**. Everything this page says follows
from keeping that sentence true.

## What a projection is promised

A read model lives in the database of its store (the event store and everything that hangs off
it: one database, one PostgreSQL schema or one Durable Object), or in a database of its own:

```ts
export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  readModels: {
    orderSummary: sqlite({ path: "./data/reporting.db" }),
  },
});
```

Either way it is a storage adapter, and the contract that adapter fulfils for a read model is
one thing above all: a transaction, holding a lock named after the read model, in which the
rows a batch writes through `table` and `client` and the checkpoint past that batch commit
together or roll back together. That is why the checkpoint of a read model on its own database
lives there, next to its rows, and why projections are exactly once per batch: a crash, a
projection that throws or a second instance can neither apply an event twice nor lose one.

That contract is also why Redis or Elasticsearch cannot be the database under `readModels`.
Neither offers the transaction: Redis queues the commands of a `MULTI` and does not roll them
back, and Elasticsearch's guide says its bulk requests are not atomic. Without it there is no
exactly once per batch to promise, only at least once, and that is a different kind of read
model (see [below](#an-external-index-is-another-kind-of-read-model)).

## Why a projection gets no ports

The [project layout](/guides/read-models/#ports) lists the three reasons in
three lines. Each one is enough on its own; here is why.

**Exactly once ends at the edge of the transaction.** What a projection writes to its tables is
undone when the batch rolls back. A call to a service is not. And batches do roll back in
normal operation: when one event of a batch throws, the whole batch rolls back and the events
before it are committed again in a transaction of their own, so their projections run twice. A
call made there is made twice, while the rows are written once. Akka Projections draws the same
line in its R2DBC module: exactly once holds because the offset is stored in the same
transaction as the handler's writes, and its at-least-once mode, which stores the offset after
the handler has run, asks for an idempotent handler. Bounda gives projections only the first
kind, so it can say "exactly once per batch" without a footnote.

**A rebuild is a second run of the whole history.**
[`bounda rebuild`](/guides/deployment/#rebuilding-a-read-model) projects every event again into a
fresh table and swaps it in. A projection that calls out would call once per event again, millions
of times for a large read model, and get today's answers: the rate of today applied to an order of
last year, a geocode that the service has since refined. The rebuilt table would differ from the one
it replaces for reasons that have nothing to do with the code being rebuilt. The point of a rebuild
is that the history has not changed, so the same code gives the same rows; a projection that reads
the world breaks that.

**On some hosts a projection runs inside the command's request.** On Cloudflare the Durable
Object brings the read models a command changed up to date before the command answers. A React
Router app does the same through `createBounda`, whose `consistency` is `"read-your-writes"` by
default, and so does any Node app that wraps itself in `readYourWrites`. Only an app that leaves
projections to a background worker keeps them out of the request. The catch-up timeout bounds the
wait, but it is checked between batches, not inside one: a call that hangs holds the request for
as long as it hangs. When the read model lives in the store's own database, the default, and that
database has a single writer (SQLite, libSQL, a Durable Object), the batch's transaction also
holds that writer, so every other command waits behind the call too. And a service that is down
makes the projection throw; a read model never skips an event, so it stops there, backing off,
until the service is back.

## Where outside data goes instead

Two places, chosen by one question: should the answer be the one from the moment of the
decision, or the one from the moment someone reads?

- **In the event, at write.** A command handler reads through its aggregate's ports (the rate,
  the stock, a price) and puts what it learned into the event it returns. The history then says
  what the decision was based on, every rebuild sees the same value, and the projection copies it
  like any other field. A call made there is safe to repeat and harmless if the decision never
  lands ([calling the outside world](/guides/calling-the-outside-world/)).
- **In the query, at read.** A read model has ports too, and they go to the `handler` of its
  queries only, not to `repository` and not to projections. A query that completes its rows with
  something fresh, a profile picture or today's rate for a display, calls it there; a query only
  reads, so a port that fails fails that query and nothing else
  ([ports of a read model](/guides/read-models/#ports)).

The rate applied to an order belongs in `OrderPlaced`; the rate shown next to a dashboard total
belongs in the query.

## An external index is another kind of read model

A search index in Typesense or Elasticsearch is a read model, but not a projection with a port.
It cannot share a transaction with a checkpoint, so it is fed at least once, and its writes have
to make a second delivery harmless. Today that is a policy of the aggregate whose events it
indexes, with a port to the index: each write is an upsert by the aggregate's id carrying
`event.version`, and the index keeps a document only when that version is newer than the one it
holds. Elasticsearch compares the version itself with external versioning
([keeping an external index](/guides/calling-the-outside-world/#keeping-an-external-index)).

This is the design Oskar Dudycz describes for Marten. His Elasticsearch projection runs only in
Marten's asynchronous daemon, and its inline path throws, so that indexing is never part of the
transaction that appends events; duplicates are absorbed by sending the stream revision as the
document's external version, which makes a repeated event fail as a conflict that can be
ignored.

## What stays outside

- **Rebuilding an external index.** `bounda rebuild` knows read models with tables; it does not
  refill an index fed by a policy, and a policy does not reprocess history.
- **An index over two aggregates.** `event.version` counts one stream's events, so it orders the
  writes of one aggregate. A document fed by two needs a policy and a port in each, and a version
  per source if both write the same document.
- **Reads inside a projection.** `client` is the read model's database inside the batch's
  transaction. Nothing outside that database, another read model's own database included, is
  part of what commits.

## Where to read more

- [Ports of a read model](/guides/read-models/#ports) and
  [keeping an external index](/guides/calling-the-outside-world/#keeping-an-external-index), the
  how.
- [What more instances do](/concepts/how-it-runs/#what-more-instances-do),
  for the lock and the transaction per batch, and
  [At least once, and exactly once per batch](/concepts/delivery-guarantees/).
- [The host decides read-your-writes](/concepts/read-your-writes/) and the
  [Cloudflare adapter](/adapters/cloudflare/#how-it-runs), for where projections run.
- Akka Projections,
  [exactly-once](https://doc.akka.io/docs/akka-projection/current/r2dbc.html#exactly-once) and
  [at-least-once](https://doc.akka.io/docs/akka-projection/current/r2dbc.html#at-least-once) with
  R2DBC.
- Oskar Dudycz,
  [projecting from Marten to Elasticsearch](https://event-driven.io/en/projecting_from_marten_to_elasticsearch)
  and
  [idempotency in the Elasticsearch read model](https://event-driven.io/en/simple_trick_for_idempotency_handling_in_elastic_search_readm_model).
- Redis
  [transactions](https://redis.io/docs/latest/develop/using-commands/transactions/#what-about-rollbacks)
  and Elasticsearch's guide on
  [bulk requests](https://www.elastic.co/guide/en/elasticsearch/guide/master/bulk.html).
