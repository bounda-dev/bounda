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

When a step fails for good, `ProcessFailed` is written to the instance's stream, naming its dead
letter, in the same transaction as the letter and the claim of what failed. From then on, each event
that would do something in the instance (it has a handler, or completes the process) is recorded
as `ProcessEventParked` in the same stream, in the order it arrived, and nothing of the process
runs for that instance, deadlines included. The event's delivery is done; the process runner moves
on, and every other instance carries on.

```
019a0c51-8d2f-7c4e-a1b2-3c4d5e6f7a80  failed  process  order.orderPayment
    OrderPaid on order:o-2, 3 attempts, last 2026-09-22T14:05:40.118Z (retriable_exhausted)
    payment provider timed out
    2 events are parked behind it; retrying it handles them in order
```

Retrying the letter, with `bounda dead-letters retry` or `app.deadLetters.retry`, runs the failed
handler again, then drains the parked events one by one, in order, each with the `idempotencyKey`
it would have had. A deadline that came due before a parked event runs before it, as it would have
if nothing had failed, and an event that arrives during the retry is parked too, so nothing
overtakes an older one. Once none is left, `ProcessResumed` puts the instance back to `started` and
its deadlines are scheduled again. Each step is one transaction, so a retry cut short goes on from
the last step written when the letter is retried again. A parked event that fails becomes the new
failure at once, without retries of its own, and the events after it stay parked behind its
letter.

Discarding the letter gives the instance up: it stays failed, its parked events never run, though
they stay in its history, and the events that reach it afterwards are dropped, as for an instance
that has ended.

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

- [A failed process](/guides/reacting-to-events/#a-failed-process) and
  [Dead letters](/guides/reacting-to-events/#dead-letters), the rules in the terms of the
  handler's code, and [`bounda dead-letters`](/reference/cli/#bounda-dead-letters).
- [Deadlines are state](/concepts/deadlines-are-state/), for the deadlines a failed instance holds.
- [Your event store is your outbox](/concepts/event-store-as-outbox/), for why the failure and its
  letter commit together.
- Error queues: NServiceBus [recoverability](https://docs.particular.net/nservicebus/recoverability/)
  and [You don't need ordered delivery](https://particular.net/blog/you-dont-need-ordered-delivery),
  MassTransit's [exceptions](https://masstransit.massient.com/documentation/concepts/exceptions),
  Wolverine's [error handling](https://wolverinefx.net/guide/handlers/error-handling.html),
  Kurrent's [persistent subscriptions](https://docs.kurrent.io/server/v25.0/features/persistent-subscriptions.html).
- Blocking: Commanded's [process managers](https://commanded.hexdocs.pm/process-managers.html),
  Axon's [event processor error handling](https://docs.axoniq.io/axon-framework-reference/4.11/events/event-processors/),
  Temporal's [failures](https://docs.temporal.io/references/failures).
- Parking: Axon's [sequenced dead-letter queue](https://docs.axoniq.io/axon-framework-reference/4.11/events/event-processors/dead-letter-queue/).
