---
title: Your event store is your outbox
description: Why a policy or process attempt in Bounda writes everything or nothing without an outbox table or a relay, what that buys, and what stays outside the promise.
sidebar:
  order: 1
---

Every messaging framework meets the same problem the day a handler does two things: it changes
state and it sends something. If the state is saved and the send is lost, or the send goes out
and the state is not saved, the system lies to itself. The known answers are the **inbox**, so a
message that is delivered twice is handled once, and the **outbox**, so what a handler emits is
stored in the same transaction as what it changed and forwarded afterwards. With a broker in the
middle, that means an outbox table, a relay that reads it, and a second delivery path to reason
about.

Bounda has no broker between an app and its own reactions. Its policies and processes read the
event store, and what they emit are commands whose events go back into the same store. So the
outbox needs no table of its own: **the event store is the outbox**, and the transaction that
makes a reaction's decision durable is the same one that makes it visible to the next reaction.
This page says what that means precisely, because the precise version is what you rely on.

## What one attempt is

A reaction runs as an **attempt**: one delivery of one event to one policy, or one step of one
process instance, whether an event, a deadline, or a step of a dead-letter retry. The runtime
claims the event in the inbox ledger, runs the handler, and only then writes, in one transaction
of the store:

- the events of every command the handler dispatched, each appended to its aggregate's stream at
  the version the handler saw;
- the scheduler rows of its scheduled commands;
- for a process step, the instance's lifecycle events (`ProcessStarted`, `ProcessHandled`,
  `ProcessCompleted`, `ProcessDeadlineReached`, `ProcessTimedOut`) and the entry of its next deadline, computed from
  the state it just wrote;
- the mark in the inbox that says the event is done;
- and, when the runtime gives up on the event, `ProcessFailed` and the dead letter (only the
  letter for a follow-up of a timed-out process, which has ended).

A handler that throws, runs out of time, or dies before the commit leaves nothing of that behind.
The claim it took expires with its lease, and the next attempt starts from the store as it is,
not from a half-written one. A commit that finds a stream moved since the handler loaded it, by
a deadline that came due or by another instance, rolls back and runs the handler again on the
new state, without counting an attempt; its claim's lease starts again first, and an attempt
whose claim another instance took over meanwhile stops instead. The scheduled-command worker
follows the same rule: a scheduled command, a delayed policy run or a process deadline commits its
writes together with the release of its claim, so a worker that dies between the two does not run
it twice, and one whose claim another instance took over writes nothing.

## What `await commands.x()` means inside a handler

The handler still dispatches commands one at a time and waits for each: the aggregate loads,
decides, and the handler gets the result at once, a rejection included, so it can compensate
in the same run. What it gets is the **decision**, not something stored. The events are staged in
the attempt, visible to the handler's own later commands against the same aggregate, and land in
the store when the attempt commits. That is why the result carries the new version and the event
types, but no global position: the position does not exist yet.

The rule this gives you is short: **call the outside world before you dispatch, not after**, and
pass the `idempotencyKey` the handler receives. If the attempt runs again, the provider sees the
same key; if it commits, everything it decided is stored at once.

## Why not the other ways

Three other designs answer the same problem, and each was tried or measured before this one.

- **One transaction around the handler.** It would make the outside call part of the
  transaction. On a store with one writer, SQLite, libSQL, a Durable Object, that blocks every
  other command of the app for as long as the call takes; on PostgreSQL it holds a connection and,
  if the append lock is taken early, serializes the whole store behind one HTTP request. Reactions
  exist to call outside, so this is the one thing they cannot hold a transaction across.
- **Hold what the handler emits and dispatch it at the end.** NServiceBus's batched dispatch and
  MassTransit's in-memory outbox do this: what the handler sends is handed to the transport only
  once the handler has completed, and nothing goes out if it throws. It keeps the handler's
  effects out of the store until it finishes, but a handler that needs the answer to what it sent
  cannot have it before then, so it cannot compensate in the same run, and once the batch is
  flushed the same gaps reappear between one write and the next: MassTransit's own docs say what
  the in-memory outbox holds is lost if the process crashes.
- **An outbox table and a relay.** NServiceBus's Outbox, MassTransit's transactional outbox,
  Wolverine with Marten. Everything is durable in one transaction, but the decision is deferred to
  the relay: the handler cannot know whether its command was accepted. It also adds a table and a
  process to run.

The attempt keeps the synchronous decision and the atomic write by staging the decision in
memory and committing it with the mark. Axon's unit of work is the closest precedent: a run
whose handler fails rolls back every change and cancels its scheduled side effects. Bounda can go
one step further than a framework built for brokers because there is nothing to forward: the
store the reaction wrote to is the store the next reaction reads.

## What stays outside

The promise is about what reaches the store. Three things are, on purpose, outside it:

- **External calls.** A provider called by a handler that then fails or dies has still been
  called; the next attempt calls it again with the same `idempotencyKey`. This is what at-least-once
  delivery means, and no transaction changes it.
- **The claim.** The inbox claim is taken before the attempt, not in its transaction, so that two
  instances on PostgreSQL never run the same handler at the same time. A crash mid-attempt leaves
  the claim pending until its lease expires; after that the event runs again.
- **Read models inside a handler.** A query in a handler sees what was committed before the
  attempt, never the events the attempt has staged. Load the aggregate through a command if the
  decision depends on what the handler itself just did.

## Where to read more

- [What the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises), the
  guarantees in the terms of the handler's code.
- [Why there is no broker](/guides/how-it-runs/#why-there-is-no-broker), for the publisher that
  takes the log out of the app.
- The precedents: Axon's [unit of work](https://docs.axoniq.io/axon-framework-reference/4.11/messaging-concepts/unit-of-work/),
  NServiceBus's [Outbox](https://docs.particular.net/nservicebus/outbox/) and
  [batched dispatch](https://docs.particular.net/nservicebus/messaging/batched-dispatch),
  MassTransit's [transactional outbox](https://masstransit.massient.com/documentation/patterns/transactional-outbox)
  and [in-memory outbox](https://masstransit.massient.com/documentation/patterns/in-memory-outbox),
  Wolverine's [Marten integration](https://wolverinefx.net/guide/durability/marten/event-sourcing.html).
