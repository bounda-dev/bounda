---
title: Core concepts
description: Every word the rest of the docs uses, one line each.
sidebar:
  order: 1
---

Bounda uses the vocabulary of event sourcing and CQRS, each word for one thing. This page defines
them in the order a request meets them; every other page assumes them.

## The write side

- **Aggregate**: a consistency boundary of the domain, such as one order, under
  `app/domain/<aggregate>/`. Each instance is identified by an id.
- **Command**: a request to change one aggregate instance, such as `placeOrder`. Its `handler`
  reads the current state and decides.
- **Event**: a fact the command decided, such as `OrderPlaced`, in the past tense. Events are
  never edited or deleted.
- **State**: what the aggregate's events add up to. `begin` builds it from the event that opens
  the aggregate, `evolve` folds every later one into it.
- **Rejection**: a command's "no", declared in its `rejections` and returned with `reject`. It is
  an answer to whoever asked, never stored. [Not every no is a fact](/concepts/rejection-or-event/)
  says when a "no" is an event instead.

## Storage

- **Store**: what Bounda runs on: one database, one PostgreSQL schema or one Durable Object. One
  per app, or one per tenant.
- **Event store**: the part of the store that keeps the events.
- **Stream**: the events of one aggregate instance, in order. A command loads it to rebuild the
  state, and appends to it with optimistic concurrency.
- **Global stream**: the order of every event in the store, across streams. Each event has a
  `position` in it; the last position is the **head**.

## The read side

- **Read model**: a table built from events, under `app/read/<read-model>/`, with its `view`
  (the columns) and its queries.
- **Projection**: what keeps a read model up to date; each of its files handles one event.
  Projections are applied exactly once per batch.
- **Query**: a named read of a read model, such as `listOrders`. Queries never touch the event
  store.
- **Rebuild**: projecting the global stream again into a fresh table, when a projection changed.

## Reactions

- **Policy**: "when this event happens, do that": a handler that runs after an event is stored and
  may dispatch commands. It keeps no state.
- **Process**: a process manager. It follows one aggregate instance over time, keeps its own
  state, listens to other aggregates' events and has **deadlines**, moments its state says it
  must act at, each with an `at-<deadline>.ts` handler. Its **timeout** is the deadline that ends
  it.
- **Scheduled command**: a command dispatched with a `delay`, stored and run when it is due.
- **Saga**: not a module. It is the pattern of a multi-step business transaction where each step
  can be compensated, built from policies or a process ([Sagas and compensation](/guides/sagas/)).

Policies and processes run **at least once, with an inbox**: an event already handled is not
handled again, but a handler that fails midway runs again, so calls it makes outside carry an
`idempotencyKey`.

## The runtime

- **Subscriber**: a reader of the global stream with its own checkpoint: each read model's
  projection, the policy runner and the process runner. `app.getLag()` says how far each is behind
  the head.
- **Dispatcher**: the loop that hands new events to the subscribers, one **pass** at a time.
- **Inbox**: the ledger of which handler has handled which event.
- **Dead letter**: an event or scheduled command a handler gave up on after its retries, kept with
  the error until someone **retries** or **discards** it with `bounda dead-letters`.
- **Upcaster**: a module next to an event that turns old payloads into today's shape as they are
  read ([Changing an event's shape](/guides/changing-events/)).

## Code around the domain

- **Port**: an interface a module needs from the outside world, such as a notifier or a payment
  gateway, in a file at the module's root.
- **Implementation**: one way to fulfil a port, under `infrastructure/<port>/`, chosen by name in
  `bounda.config.ts` and replaced by a double in tests
  ([Every module is a hexagon](/concepts/every-module-is-a-hexagon/)).
- **Host**: what runs the app and talks to it: a Node script, a React Router app or a Cloudflare
  Worker.

[How Bounda runs](/concepts/how-it-runs/) puts these together with numbers;
[Project layout](/guides/project-layout/) says which file holds each one.
