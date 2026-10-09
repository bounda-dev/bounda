---
title: At least once, and exactly once per batch
description: Why Bounda delivers events to policies and processes at least once with an inbox, applies projections exactly once per batch, and where each promise stops.
sidebar:
  order: 10
---

Bounda makes two different promises about delivery, and the difference is deliberate. Policies
and processes, the **reactions**, run **at least once, with an inbox**. Projections are applied
**exactly once per batch**. The two are not a strong and a weak version of the same thing: a
projection writes only to a database Bounda holds a transaction on, and a reaction exists to
call something it does not. This page explains why that difference decides everything, what
each promise covers, and where it stops. [How Bounda runs](/concepts/how-it-runs/#what-more-instances-do)
says what it means across instances; this page says why.

## Why a reaction cannot be exactly once

A reaction charges a card, sends an email, refunds a payment. Somewhere in it there is a call to a
provider, and then the attempt commits what it decided. If the process dies between the two, the
provider has done its work and the store has no record of it. Nothing can close that gap: **no
transaction covers an HTTP call**, and the next attempt cannot tell whether the call before it
reached the provider, failed, or succeeded with an answer that was lost. Tyler Treat's essay puts
the general result plainly, "you cannot have exactly-once message delivery", and the Two Generals
problem it rests on concerns any two parties talking over a network, a handler and its provider
included.

So the honest promise is at least once, and the work is in what happens to the second delivery.
Bounda answers in two layers: the **inbox** makes an event delivered twice be handled once by the
store, and the **`idempotencyKey`** carries the same identity to the provider, which is the only
party that can recognise a repeated call.

## The inbox: handled once by the store

The policy runner and the process runner are subscribers, `policies` and `processes`, each with one
checkpoint in the **store** (the unit per tenant: one database, one PostgreSQL schema or one
Durable Object, with everything that hangs off its event store). Their checkpoint moves with a
compare-and-set and no lock, so an event can reach a handler more than once: a crash after the
handler committed but before the checkpoint moved, or two instances reading the same batch. That
is allowed because the inbox ledger stands in front of every handler. Before running, the runtime
claims `(handler, event)`, and the claim is atomic: of two instances racing for it, exactly one
wins. What a second delivery finds decides what happens:

- **Succeeded**: the handler is not run again. This is the common case, and nothing is repeated.
- **Pending, inside its lease**: another instance is running it. This one holds the event, and the
  handler's later events of the batch wait behind it, so they do not overtake it.
- **Pending, lease expired**: the instance that took it died or stalled. The handler runs again.
  This is the one case where the outside world sees a second call.
- **Failed**: a retry, run again once its back-off is due.

The mark that says "succeeded" is not written on its own. It is staged in the attempt and commits in
one transaction with the events of the commands the handler dispatched and its scheduled commands,
and it settles the claim by the id it was given. An attempt that stalled past its lease and whose
claim another instance took over finds that id gone, and its whole transaction rolls back: what it
decided is stored by whoever holds the claim, never by both. [Your event store is your outbox](/concepts/event-store-as-outbox/#what-one-attempt-is)
describes the attempt in full. For everything the store holds, an event delivered twice is handled
once.

## The `idempotencyKey`: carrying it to the provider

The store's side is settled; the provider's is not, and only the provider can settle it. Every
policy and process handler receives an `idempotencyKey`, a UUID derived from the handler and the
event (for a deadline, from the instance and the moment). It is the same on every automatic retry
of that handler for that event, and new when an operator retries a dead letter, so a provider that
stored the failed attempt's answer sees a new request. From `examples/storefront`:

```ts
// app/domain/payment/policies/refund-on-refund-requested.ts
export const handler = async ({ event, commands, gateway, idempotencyKey }: Policy.HandlerArgs) => {
  const { intentId, amount } = event.payload;
  const { refundId } = await gateway.refund({ intentId, amount, idempotencyKey });
  await commands.recordRefund({ paymentId: event.aggregateId, refundId });
};
```

If this attempt dies after the refund and before the commit, the next one calls `refund` with the
same key, the provider answers with the refund it already made, and `recordRefund` commits once.
The duplicate delivery happened; the duplicate refund did not. A handler that causes two effects
derives a key for each with `idempotencyKeyFor(idempotencyKey, "refund")`, and the commands a
reaction dispatches get ids derived from its key, so an attempt that runs again and schedules the
same command stores it once. A provider that accepts no key needs the same care by other means: an
upsert by id, or a check of the event's `version`, as in
[keeping an external index](/guides/reacting-to-events/#keeping-an-external-index).

## Exactly once per batch, for projections

A projection writes only rows of its read model, through `table` and `client`, and gets no ports.
That makes a stronger promise possible. Each batch runs in one transaction of the read model's
database: the rows the batch writes and the checkpoint past it commit together or roll back
together. The transaction holds a lock named after the read model, so one instance at a time
applies it: a two-key `pg_advisory_xact_lock` on PostgreSQL, the single writer on SQLite and
libSQL, the storage transaction in a Durable Object. Under the lock the checkpoint is read again,
and a batch whose checkpoint someone else moved (another instance, an operator, a rebuild) rolls
back instead of being applied over newer work.

There is no inbox here because none is needed: the checkpoint is the record of what was applied,
and it is in the same transaction as what was applied. A projection that throws at the fifth event
of a batch rolls back the batch; the four events before it are committed again on their own, and
the fifth is delivered until it succeeds, never skipped. A read model kept in a database of its own
keeps its checkpoint in that database, next to its rows, because a transaction cannot span two.

## What stays outside

- **Anything a projection does outside `table` and `client`.** `client.raw` is inside, since in a
  batch it is the driver's transaction handle. An HTTP call or a write to another database is not:
  a batch that rolls back makes it again. That is why projections get no ports
  ([why](/guides/project-layout/#ports-of-a-read-model)) and an external index is fed by a policy.
- **A rebuild.** [`bounda rebuild`](/guides/deployment/#rebuilding-a-read-model) replays history
  into a fresh table on purpose. Exactly once holds per table, not across rebuilds.
- **The provider's side of a reaction.** Without a key the provider honours, at least once means
  what it says. Bounda never calls a reaction exactly once, and neither should the code around it.

## Why not the other ways

- **Kafka's exactly-once semantics** make writes across partitions and the consumer's offsets
  atomic, and Kafka Streams builds read-process-write on that. Confluent's own explanation scopes it
  to processing inside Kafka: an RPC from a Streams app to a remote store is not covered. It is the
  same boundary as here, drawn around a broker instead of a database.
- **Akka Projections** offers exactly-once only when the projection's writes run in the same
  transaction as the stored offset, and at-least-once otherwise. Bounda's projections are that
  first mode, always, because their offset always lives next to their rows.
- **The NServiceBus Outbox** deduplicates incoming messages by `MessageId` and stores outgoing ones
  with the business data, and says its guarantee does not reach operations that do not enlist in
  the transaction, such as sending email. Bounda's inbox is the same deduplication; the outgoing
  side needs no table, because the event store is the outbox.
- **Marten** and **Commanded** say the same of their own subscribers and handlers: delivery is at
  least once, and a handler must expect to see an event again.

Exactly once where a transaction reaches, at least once with deduplication where it does not: every
framework that is precise about it lands on the same line. Bounda draws it at the read model.

## Where to read more

- [What the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises), the same
  guarantees in the terms of a handler's code, and [retries and timeouts](/guides/reacting-to-events/#retries-and-timeouts).
- [What more instances do, and do not do](/concepts/how-it-runs/#what-more-instances-do)
  and [a projection that keeps failing](/guides/deployment/#a-projection-that-keeps-failing).
- [Your event store is your outbox](/concepts/event-store-as-outbox/) and
  [where a broker goes](/concepts/where-a-broker-goes/).
- Tyler Treat, [You Cannot Have Exactly-Once Delivery](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/).
- Confluent, [Exactly-once semantics are possible: here's how Apache Kafka does it](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/).
- Akka, [R2DBC projections](https://doc.akka.io/docs/akka-projection/current/r2dbc.html);
  NServiceBus, [Outbox](https://docs.particular.net/nservicebus/outbox/);
  Marten, [subscriptions](https://martendb.io/events/subscriptions);
  Commanded, [domain events and handlers](https://commanded.hexdocs.pm/events.html).
