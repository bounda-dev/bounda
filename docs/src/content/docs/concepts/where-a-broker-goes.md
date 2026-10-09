---
title: A broker goes behind the event store
description: Why Bounda puts no broker between an app's writes and its read models, where Kafka or RabbitMQ does belong, and which pieces connect one without rewriting modules.
sidebar:
  order: 11
---

Sooner or later someone asks where Kafka goes. The answer has two halves. Inside an app, nowhere:
**a broker goes behind the event store, never between an app's writes and its read models.** Between
services, it is the right tool, and Bounda will connect to one as one more subscriber, not as a
change to how modules are written.
[No broker inside the app](/concepts/how-it-runs/#no-broker-inside-the-app) gives the short version;
this page gives the reasons and the pieces.

## The event store is already the queue

In an event-sourced app the events a command appends are the messages. Every **store** (the unit per
tenant: one database, one PostgreSQL schema or one Durable Object) holds them in one global stream,
and everything that reacts to them is a subscriber of it with a checkpoint: each projection
(`projection:<read model>`), the policy runner (`policies`) and the process runner (`processes`).
A subscriber reads the events after its checkpoint, in order, and moves the checkpoint past what it
finished. That is a durable, ordered queue with consumer offsets, which is what a broker sells. The
event store adds what a broker does not have: loading one aggregate's stream by id, and an append
that fails when the stream moved since the command loaded it.

Axon, which ships a Kafka extension, is blunt about the difference: Kafka distributes events well,
but "it is not an event store", and the extension cannot be used to event-source aggregates.

## What a broker in the middle costs

Put a broker between the writes and the read models and three things get worse at once.

- **It forces an outbox.** The command's events must reach the database and the broker. Two writes
  without a shared transaction can disagree, so the known fix is an outbox table in the database and
  a relay that forwards it: one more table, one more process, one more delivery path. Without a
  broker in the middle the event store already is that outbox
  ([why](/concepts/event-store-as-outbox/)).
- **It loses order outside a partition.** Kafka guarantees order within a partition, and routes
  events with the same key to the same one. A read model of orders per customer needs
  `CustomerRegistered` before `OrderPlaced`, from two aggregates and so from two keys; across
  partitions nothing orders them. The global stream does
  ([why a single order](/concepts/how-it-runs/#why-a-single-order)).
- **It limits replay to its retention.** Kafka keeps events for a per-topic period, after which old
  ones are discarded, and its own introduction contrasts that with traditional messaging systems,
  which delete a message once it is consumed.
  [`bounda rebuild`](/guides/deployment/#rebuilding-a-read-model) needs the whole history, and a new
  read model starts from the first event. The event store keeps all of it, because it is the source
  of truth, not a transport.

Confluent's essay on event sourcing and Kafka argues the other way round: Kafka as the backbone that
stores the events, with read stores and lookups by key built by Kafka Streams. That design suits a
platform of stream processors. For an app whose commands decide from an aggregate's own stream, it
gives up the two things the event store adds, and rebuilds what the database already does.

## Where a broker belongs

A broker earns its place **between services**: another bounded context, a data warehouse, a company
that already runs Kafka. There, temporal decoupling is the point, and no single database holds both
sides. Mathias Verraes's patterns for messaging between contexts are the reference for what crosses
that line: keep internal events private by default, publish an explicit set of public events, and
translate at the boundary so consumers do not couple to the inside of the context. Whether a service
should call another or listen to it is its own question, which CodeOpinion's video below takes on.

## Three pieces, none built yet

A broker enters Bounda by three pieces. None of them exists today, and each fits the model as it is.

- **A publisher.** One more subscriber of the global stream with its own checkpoint: read the events
  after it, publish them, advance when the broker confirms. A crash between the confirmation and the
  checkpoint publishes again, so it is at least once and consumers deduplicate by event id
  ([the guarantees](/concepts/delivery-guarantees/)). It is the outbox pattern with no outbox table.
- **Consuming from a broker.** A message from another service enters the app as a command, the way a
  webhook does. The piece to build reads a topic, dispatches commands and keeps the broker's offset;
  the command is already the place that makes a repeated message harmless, as
  `examples/storefront` does for a provider's webhook that may arrive twice or out of order:

  ```ts
  // app/domain/payment/commands/settle-payment.ts (abridged)
  export const handler = ({ state, events, reject }: Command.HandlerArgs) => {
    switch (state.status) {
      case undefined:
        return reject("NeverRequested");
      case "requested":
      case "processing":
        return [events.paymentSettled({ orderId: state.orderId })];
      case "settled":
        return [];
      // ...
    }
  };
  ```

- **Projections by segments.** Today one read model is applied by one instance at a time, in order.
  Splitting its projection by aggregate id into segments, each in order with its own checkpoint,
  lets several instances apply one read model, and maps onto a partitioned topic, where order only
  exists per key anyway.

What works today without them: a policy can publish through a port like any outside call, at least
once, with its `idempotencyKey` as the message id. It reacts only to events stored after it is
deployed, and only to the events it lists, so it is a bridge for a few public events, not a
publisher of the store.

## An integration event needs an envelope

An event that leaves the app is a contract with strangers, and it needs more than a stored event
says. A stored event carries its `type` and `aggregateType`, which together name it inside the app
(`order.OrderPlaced`), the aggregate's id and `version`, its `position` and `timestamp`, and
metadata: `correlationId`, `causationId` (the event that led to it, or the request's command),
`commandId` (the command that wrote it) and `schemaVersion` (the shape its payload was written in,
which upcasters raise). Outside, it also needs:

- a **type namespaced by the bounded context** (`sales.order.OrderPlaced`), because another
  service's `order` is not this one;
- the **publishing context**, so a consumer knows which service and store spoke;
- the **causation** that already exists, so a chain can be followed across services;
- a **schema version** for the public shape, which is not the internal one: following Verraes, the
  public event is a translation, as Akka's guide does when it maps internal events to a public
  Protobuf representation before sending them to Kafka.

## How the others place it

Every framework here keeps the broker downstream of its event store, fed by a subscriber:

- **Axon** distributes events through its Kafka extension and stores them in Axon Server or a
  relational database, since Kafka is not an event store.
- **Marten** lists publishing to an external system as a use of its subscriptions, which run in its
  async daemon and deliver at least once.
- **Kurrent** runs connectors inside the database: a catch-up subscription feeding a sink, with
  sinks for Kafka and RabbitMQ among others.
- **Eventuous** has a gateway that connects a subscription on the event store to a producer for a
  broker, with a transform in between.
- **Akka**'s guide to Kafka between two services publishes from a projection over the journal and
  consumes in the other service from a Kafka source.
- **Commanded** gives each event handler its own subscription and position in the event store, and
  names talking to third-party systems as a use of handlers.

## Start with one database

The path is short to state. **Start with one database**: one store per tenant, no broker, nothing
else to operate. When the app grows into several services, or a company Kafka has to hear from it,
connect the broker behind the event store, through a publisher and a consumer. Modules do not
change: a policy is still a policy, a projection still a projection, because the broker is one more
subscriber, not a new way to deliver events inside the app.

## Where to read more

- [No broker inside the app](/concepts/how-it-runs/#no-broker-inside-the-app) and
  [the way out: one store per tenant](/concepts/how-it-runs/#the-way-out-one-store-per-tenant).
- [Your event store is your outbox](/concepts/event-store-as-outbox/) and
  [at least once, and exactly once per batch](/concepts/delivery-guarantees/).
- Mathias Verraes, [DDD and Messaging Architectures](https://verraes.net/2019/05/ddd-msg-arch/), in
  particular
  [Explicit Public Events](https://verraes.net/2019/05/patterns-for-decoupling-distsys-explicit-public-events/)
  and
  [Segregated Event Layers](https://verraes.net/2019/05/patterns-for-decoupling-distsys-segregated-event-layers/).
- CodeOpinion, [RPC vs Messaging: When to use which?](https://www.youtube.com/watch?v=LMKVzguhFw4).
- Neha Narkhede (Confluent),
  [Event sourcing, CQRS, stream processing and Apache Kafka: What's the connection?](https://www.confluent.io/blog/event-sourcing-cqrs-stream-processing-apache-kafka-whats-connection/);
  Apache Kafka, [introduction](https://kafka.apache.org/intro), for retention and partitions.
- Axon, [Kafka extension](https://docs.axoniq.io/kafka-extension-reference/4.12/); Marten,
  [subscriptions](https://martendb.io/events/subscriptions); Kurrent,
  [connectors](https://docs.kurrent.io/server/v25.0/features/connectors/) and its
  [sinks](https://docs.kurrent.io/server/v25.0/quick-start/whatsnew); Eventuous,
  [gateway](https://eventuous.dev/dotnet/gateway/); Akka,
  [Kafka between two services](https://doc.akka.io/libraries/guide/how-to/projection-kafka.html);
  Commanded, [domain events and handlers](https://commanded.hexdocs.pm/events.html).
