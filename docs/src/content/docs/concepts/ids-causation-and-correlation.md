---
title: Ids, causation and correlation
description: What every stored event says about where it came from, how to follow a chain from a request to its last reaction, and why ids a reaction creates are derived, never random.
sidebar:
  order: 40
---

A request places an order; a process asks for a payment; a policy sends a confirmation; a day
later a scheduled command sends a reminder. Four writes, three of them made by the runtime, some
in another process and one on another day. When something goes wrong in the fourth, the
question is always the same: which request started this, and what did each step react to?
**Bounda answers it by stamping every event with where it came from, at the moment it is
written**, with no setting to turn on and nothing for a handler to pass along.

## What an event carries

An event as the event store holds it (`StoredEvent` in `@bounda-dev/core`) has its `id` (a UUID
v7 by default), its aggregate's type and id, its `version` in the aggregate's stream, its
`position` in the global stream, a `timestamp`, and `metadata`:

- `correlationId`: the same for everything one request caused, however many hops away.
- `causationId`: what caused the command that wrote the event. For a reaction's command it is
  the event the reaction ran for, so an event leads to the one before it; for a command from
  outside it is the command itself.
- `commandId`: the command that wrote the event. The events the runtime writes itself have none.
- `depth`: how many reactive hops separate the event from the request. A command dispatched past
  `runtime.policies.maxChainDepth` is refused with `CHAIN_DEPTH_EXCEEDED`, so a policy that
  feeds itself cannot loop for ever.
- `schemaVersion`: the shape the payload was written in, which [upcasters](/guides/changing-events/)
  read from.
- `system`: `true` for the events the runtime writes itself, such as a process's lifecycle events.

A command carries the correlation, the causation and the depth plus its own `commandId`, and a
command handler sees them on `command.metadata`; a policy or process handler sees an event's on
`event.metadata`.

## How the ids are set

A command dispatched from outside the runtime, by a request, a script or a webhook, gets a new
`commandId` and is its own cause. Its correlation is its own id too, unless the caller passes
one: `commands.x(payload, { correlationId })` joins it to a request id the host already has. Its
events copy its correlation, causation and depth, and name it as their `commandId`.

A reaction carries the event it reacts to: the commands a policy or a process step dispatches
keep the event's correlation, take its id as their causation, and go one hop deeper; the events
they write keep that causation, so they point at the event, not at a command the store never
held. A process's
own lifecycle events (`ProcessStarted`, `ProcessHandled`, `ProcessCompleted`) point straight at
the event they handled. A deadline has no event to react to, so its commands are caused by the
lifecycle event that records it (`ProcessDeadlineReached` or `ProcessTimedOut`), under the
correlation of the event that started the instance. A scheduled command keeps the correlation
and causation it was scheduled with, whenever it runs.

In the [storefront example](/examples/storefront/) one `placeOrder` gives this chain, every
event under the command's id as correlation:

| Event | `causationId` | `commandId` | Depth |
| --- | --- | --- | --- |
| `OrderPlaced` | the `placeOrder` command | `placeOrder` | 0 |
| `PaymentRequested` | `OrderPlaced` | `requestPayment`, which `orderLifecycle` dispatched | 1 |
| `ConfirmationSent` | `OrderPlaced` | `recordConfirmationSent`, from `sendConfirmationOnOrderPlaced` | 1 |
| `ReminderSent`, a day later | `OrderPlaced` | `sendReminder`, scheduled by `scheduleReminderOnOrderPlaced` | 1 |

Reading it back is a filter on `metadata.correlationId`, ordered by `position`, and walking from
an event to its cause is a lookup of the event whose `id` is its `causationId`, up to the event
whose `causationId` is its own `commandId`, which a request's command wrote; the metadata is stored as JSON, `jsonb` on PostgreSQL. In traces, every `bounda.command`, `bounda.policy` and
`bounda.process` span carries `bounda.correlation_id`, and a command's span adds
`bounda.causation_id`: the event the command reacted to, or the command itself when it came from
outside (see [Observability](/reference/observability/)).

## Ids a reaction creates

A reaction runs at least once
([what the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises)), so whatever it
creates has to come out the same on every run. Its `idempotencyKey` already does: a UUID v5 of the
handler's kind, its name and what it runs for, the event or the deadline. An aggregate the run
starts takes its id from that key, as `orderLifecycle` does with its payment:

```ts
// app/domain/order/processes/order-lifecycle/on-order-placed.ts
import { asDuration, idempotencyKeyFor } from "@bounda-dev/core";
import type { Process } from "./+types/on-order-placed";

export const handler = async ({
  event,
  aggregateId,
  commands,
  idempotencyKey,
  after,
}: Process.HandlerArgs) => {
  const paymentId = idempotencyKeyFor(idempotencyKey, "payment");
  await commands.requestPayment({ paymentId, orderId: aggregateId, amount: event.payload.total });
  return {
    paymentId,
    paymentDeadline: after(asDuration(process.env.PAYMENT_WINDOW ?? "72h")),
  };
};
```

With `randomUUID()`, a run whose `requestPayment` had already called the gateway, and that died
before its commit, would retry with another payment id: a second payment aggregate, and the gateway
asked again under the same command key with other parameters. A request's own ids are another
matter: nothing in Bounda runs a request's code again, so the onboarding example's `register` action
is right to use `crypto.randomUUID()`.

The obvious alternative is to derive the id from the command that creates it, and Bounda does
give the commands a run dispatches deterministic ids. But a command's id counts how many commands
of its type the run dispatched before it, so it depends on the order of the handler's code. A
deploy that adds a `requestPayment` earlier in the handler, or reorders two, would hand a retry
in flight a new id, and the payment would be made twice. **`idempotencyKeyFor(key, name)`
depends on the key and the name alone**, so it stays put across every automatic retry and every
release.

## What other frameworks do

The convention is usually credited to Greg Young, who presents the three ids, message,
correlation and causation, in his talks as a way to follow cascading flows
([InfoQ's report of one, 2017](https://www.infoq.com/news/2017/11/event-sourcing-microservices);
[Arkency](https://blog.arkency.com/correlation-id-and-causation-id-in-evented-systems/) credits
him too).

- **Axon** fills message metadata through correlation data providers. Since Axon 5 the default
  one sets `causationId` to the parent message's id and `correlationId` to the root's (Axon 4
  called them `correlationId` and `traceId`). An event's parent is the command that wrote it, and
  commands are not in Axon's event store.
- **Rails Event Store** publishes a handler's events with the handled event's id as their
  `causation_id`, so events point at events, and a handler can link each one into
  `causation-<id>` and `correlation-<id>` streams.
- **Eventide** writes commands to streams like any other message, and its causation fields name
  the stream and position of the message that caused this one, which can always be read back.
- **Marten** stores both on events only when `CorrelationIdEnabled` and `CausationIdEnabled` are
  switched on, and takes them from the session or from the active OpenTelemetry span.
- **EventStoreDB/Kurrent** leaves them to the client as `$correlationId` and `$causationId` in
  event metadata; the `$by_correlation_id` system projection, stopped by default, links events
  into a `$bc-<id>` stream per correlation, and its causation graph expects `$causationId` to be
  another event's id.
- **NServiceBus** copies `CorrelationId` and `ConversationId` from the incoming message and sets
  `RelatedTo` to the id of the message that caused the send.

Bounda's difference is that nothing is optional: the runtime is the only one that dispatches a
reaction's commands, so it threads the context through as an argument, without ambient state. Its
store holds events only, like Axon's, so it follows Rails Event Store and Kurrent in pointing an
event at the event before it, and keeps the command apart as `commandId`.

## What starts a change, in each school

The thing that starts a chain has a name in every school. Redux calls it an **action**, and
[describes it](https://redux.js.org/tutorials/fundamentals/part-2-concepts-data-flow) as an event
that happened. Clean Architecture's
[**use case**](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html) holds
the application-specific rules and directs the entities. DDD's **application service** is Evans's
application layer: thin, coordinating domain objects
([as Fowler quotes it](https://martinfowler.com/bliki/AnemicDomainModel.html)). CQRS calls it a
[**command**](https://martinfowler.com/bliki/CQRS.html), the update side's request.

Bounda takes the CQRS word. A command is the root of a correlation and writes its events, and
its module is also what the other schools split in two: the runtime loads the state, the handler
calls its ports and decides, and there is no application service around it. An action, in the React
Router sense, is the host's: the place where a request dispatches a command.

## What stays outside

- **Commands are not stored.** An event names its command by `commandId`; what else is known
  about the command is on its span.
- **Not every cause is an event.** What a process writes with no event to react to, a deadline
  reached, a timeout, a resume or a deadline that fails, points at the instance's stream
  (`process:<name>:<id>`), and a retry from a dead letter at the letter.
- **No query by correlation or causation.** There is no API for either, and no index on the
  metadata column.
- **One request is not one trace.** A policy runs in a later pass, so its span starts a new
  trace; the correlation id is what joins them
  ([what is not there yet](/reference/limitations/)).
- **A key names its handler.** Renaming a policy or a process changes the key, and every id derived
  from it, for a retry in flight. And a command a reaction dispatches hands its command id to its
  own handler as `idempotencyKey`, so a deploy that reorders dispatches of one type changes the
  key that handler gives its provider.
- **A retry from a dead letter is a new request on purpose.** It gets a new key, so ids derived
  from it are new; a retried scheduled command also starts a new correlation, caused by the letter.

## Where to read more

- [Calling the outside world](/guides/calling-the-outside-world/), for keys and
  derived ids in a handler, and [Every step is idempotent](/guides/sagas/#every-step-is-idempotent).
- [Observability](/reference/observability/), for the spans and their attributes.
- The other frameworks: Axon's
  [message correlation](https://docs.axoniq.io/axon-framework-reference/5.3/messaging-concepts/message-correlation/),
  Marten's [event metadata](https://martendb.io/events/metadata.html), Rails Event Store's
  [correlation and causation](https://blog.arkency.com/correlation-id-and-causation-id-in-evented-systems/),
  Kurrent's
  [system projections](https://docs.kurrent.io/server/v24.10/features/projections/system.html) and
  [its blog on causation](https://kurrentdb.kurrent.io/blog/eventstoredb-visualise-tab/),
  NServiceBus's [message headers](https://docs.particular.net/nservicebus/messaging/headers).
