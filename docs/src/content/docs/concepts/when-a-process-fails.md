---
title: When a process fails
description: Why a failed process instance in Bounda parks its later events in its own stream, in order, until the failure is retried, and how that compares with error queues, blocking and Axon's sequenced dead-letter queue.
sidebar:
  order: 31
---

A process step can fail for good: a bug, a provider that stays down past every retry, a command
that can never succeed. The runtime gives up on it and files a dead letter. The hard question is
not that step but the next ones. The process keeps receiving events for the same instance, and
the `OrderPaid` that arrives while it is failed on a reminder is exactly the one it must not miss,
nor run before the failure it waits behind.

Bounda's answer is that **a failed instance parks its later events in its own stream, in order,
and drains them when the failure is retried**. Other instances of the process go on. This page
explains why that is possible here when it is not in most frameworks, and what it leaves out.

## Three answers elsewhere

**A dead letter per message, and the rest go on.** NServiceBus moves a message that fails every
retry to the error queue and marks it processed; MassTransit moves it to the `_error` queue next
to the input queue; Wolverine to its error queue; Kurrent's persistent subscriptions park it in a
parked-message stream and continue. Nothing is blocked, and nothing is ordered either: the
messages after the failed one are handled before it, and Kurrent says plainly that a persistent
subscription does not guarantee order. Particular argues that this is fine, because a business
copes with things arriving out of order and a saga can be written to accept its messages in any
order. It can, at the price of every handler of the saga tolerating every order.

**Block until it is fixed.** Commanded stops a process manager that fails, by default; under its
supervisor it starts again and retries the same event. Axon's propagating error handler puts a
streaming processor into error mode, retrying with a growing back-off, and its documentation warns
that the processor stalls entirely while the cause persists. Temporal does not fail a workflow
whose code throws an ordinary error, a bug: it retries the workflow task until the execution
timeout, unlimited by default, so the workflow waits for a deploy that fixes it. Order is kept,
but what waits is not always one instance's work: a stalled Axon processor holds every event it
would have handled, whatever saga it belongs to.

**Park the sequence.** Axon's sequenced dead-letter queue is the middle way: it dead-letters the
failed event and every later event of the same sequence, keeps the other sequences flowing, and
retries a sequence as a whole. It has two limits that matter for processes. It does not support
sagas, because a saga's associations can change from one event to the next, so there is no stable
sequence to park. And it holds 1024 sequences by default, with as many letters per sequence;
beyond that the processing group stops.

## What Bounda does

Bounda has the key Axon's queue lacks for sagas. A process always lives on one aggregate, and
every event it takes is assigned to an instance by the id of that aggregate: its own events by
their `aggregateId`, another aggregate's by the id field they carry or by `correlate`. That id
never changes, so the instance is a stable sequence, and parking can follow it.

So when a step fails for good, the instance parks every later event in its own stream, in the
order it arrived, and the process runner moves on to the other instances. Retrying the dead letter
runs the failed handler again and drains what is parked, in order, before the instance resumes;
discarding it gives the instance up. [A failed process](/guides/dead-letters/#a-failed-process) has
the rules: what is parked, how deadlines interleave, and what a retry cut short does.

## Why not park them as dead letters

The obvious alternative files each later event as a dead letter of its own, waiting behind the
one that failed. Two things rule it out. Order depends on the operator: once the blocking letter
is retried and the instance runs again, a new event can run before the parked letters are,
overtaking them. And the dead-letter store would need new statuses and columns to say which
letter waits behind which. In the stream, the order is the stream's own, the parked events are
part of the instance's history next to the failure they wait on, and the dead-letter store keeps
one letter per failure with its three statuses, `failed`, `retried` and `discarded`.

There is no cap like Axon's either: a parked event is one more event in one instance's stream.

## What stays outside

- **Retries before the failure is final.** While a step waits for its back-off, the process is
  handed none of its later events, whatever their instance: the retries keep order by holding the
  process, and only a failure for good parks one instance and lets the others through. The
  default budget is short; a long one holds every instance of the process for as long.
- **Policies.** A policy remembers nothing, so it has no instance to park on. Its dead letter
  stands alone and its later events go on; retrying it runs the handler once more.
- **A timed-out process.** It has ended, so a follow-up of its `at-timeout.ts` that fails is only
  dead-lettered, with nothing parked. A failure on the timeout itself, once retried, ends the
  process and drops what was parked, as does a parked event that completes it.
- **The fix.** Parking keeps the events; it does not repair anything. Retrying the letter before
  the cause is fixed fails again, on the same step or on a parked one.
- **The outside world.** A drained event's handler calls providers as it would have the first
  time, with the same `idempotencyKey`; the retried handler gets a new one.

## Where to read more

- [A failed process](/guides/dead-letters/#a-failed-process) and
  [Dead letters](/guides/dead-letters/), the rules in the terms of the
  handler's code, and [`bounda dead-letters`](/reference/cli/#bounda-dead-letters).
- [Deadlines are state](/concepts/deadlines-are-state/), for the deadlines a failed instance holds.
- [Your event store is your outbox](/concepts/event-store-as-outbox/), for why the failure and its
  letter commit together.
- Error queues: NServiceBus
  [recoverability](https://docs.particular.net/nservicebus/recoverability/) and
  [You don't need ordered delivery](https://particular.net/blog/you-dont-need-ordered-delivery),
  MassTransit's [exceptions](https://masstransit.massient.com/documentation/concepts/exceptions),
  Wolverine's [error handling](https://wolverinefx.net/guide/handlers/error-handling.html),
  Kurrent's
  [persistent subscriptions](https://docs.kurrent.io/server/v25.0/features/persistent-subscriptions.html).
- Blocking: Commanded's [process managers](https://commanded.hexdocs.pm/process-managers.html),
  Axon's
  [event processor error handling](https://docs.axoniq.io/axon-framework-reference/4.11/events/event-processors/),
  Temporal's [failures](https://docs.temporal.io/references/failures).
- Parking: Axon's
  [sequenced dead-letter queue](https://docs.axoniq.io/axon-framework-reference/4.11/events/event-processors/dead-letter-queue/).
