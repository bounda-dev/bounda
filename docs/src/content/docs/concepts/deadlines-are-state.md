---
title: Deadlines are state
description: Why a process in Bounda keeps every moment it acts at as a field of its state, with no timer to schedule or cancel, and how that compares with timer APIs and scheduled commands.
sidebar:
  order: 30
---

A process waits. It expects a payment within 72 hours, a reminder every day until then, an answer
before the order goes stale. Most frameworks give it a **timer**: a call that schedules a message
for later, returns a handle, and a second call that cancels it. The process then holds two things
that have to agree, its state and the timers it has asked for, and every bug in that area is a
case where they do not.

Bounda has no timer API. **A deadline is a field of the process state**: setting it schedules,
changing it moves, `null` cancels, and the scheduler only ever holds what the state says. This page
explains that choice and what it costs.

## What a deadline is

A field declared with `deadline()` is a moment the process acts at, `null` while nothing is due.
Its handler is the file named after it, `at-<field>.ts`. The storefront's order process opens a
payment window when the order is placed and closes it as soon as the payment moves:

```ts
// order/processes/order-lifecycle/index.ts
export const state = ({ z, deadline }: Process.StateArgs) =>
  z.object({ paymentId: z.uuid().nullable().default(null), paymentDeadline: deadline() });

// order/processes/order-lifecycle/on-order-placed.ts (abridged)
return { paymentId, paymentDeadline: after("72h") };

// order/processes/order-lifecycle/payment/on-payment-settled.ts (abridged)
return { paymentDeadline: null };

// order/processes/order-lifecycle/at-payment-deadline.ts
export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "not paid in time" });
  return { paymentDeadline: null };
};
```

There is no id to keep and nothing to cancel by. Each instance has **one** scheduler entry, at
its earliest pending deadline and written with the state it comes from, and when it comes due the
runtime does not trust it: it works out from the state what is due, so an entry the state no
longer backs runs nothing. `ProcessDeadlineReached` records in the instance's stream that a
deadline came due. How `after()` counts and what a deadline handler must return are in
[Deadlines](/guides/reacting-to-events/#deadlines).

## The timeout is a deadline too

The time a process may stay open is the reserved deadline `timeout`, handled by `at-timeout.ts`, and
reaching it ends the process at once. What its commands cause is not lost: those events still reach
the ended instance's handlers, as follow-ups ([the rules](/guides/reacting-to-events/#deadlines)).
The storefront's `at-timeout.ts` cancels the order, and the `OrderCancelled` it causes runs
`on-order-cancelled.ts`, which cancels the payment, exactly as for a cancellation from anywhere
else. The compensation is written once.

## What it buys

- **Nothing to keep in sync.** The state is the only record of what is due. A cancel cannot get
  lost on its way, because there is no cancel to send.
- **No stale timer to defend against.** A handler never has to ask whether the deadline it was
  woken for still matters: if the state moved it, it does not run.
- **History.** The moment is in the state the lifecycle events record, and `ProcessDeadlineReached`
  says when it was reached, so a replay or an audit sees time as it passed.
- **Tests without timers.** Advance the test clock and run until idle; every deadline it passes
  runs in order ([Time](/guides/testing/#time)).

## Why not the other ways

**A timer with its own API.** Axon's deadline manager returns a `deadlineId` the saga stores to
cancel it later; Akka's `TimerScheduler` keys timers per actor and cancels them by key; NServiceBus
requests a timeout that comes back as a message. Each one duplicates state, and the duplicate is
where it hurts. NServiceBus cannot cancel or reschedule a timeout, and a second request does not
replace the first: both fire. Its documentation tells the saga to keep flags in its data and
ignore a timeout that no longer applies, and the answer on its forum to extending one is a flag
and a second timeout. MassTransit users have seen a cancel lost on Azure Service Bus and the
timeout delivered anyway. Wolverine documents no way to cancel a saga's timeout message, and one
that reaches a saga already completed needs a `NotFound` handler. Akka cancels an actor's timers
when it restarts, and its maintainers suggest starting them again once an event-sourced actor has
recovered its state. Axon's simple deadline manager does not persist at all: its schedules are
lost when the JVM stops. In every case the state already knew what was due; the timer was a second
copy that could drift.

**A scheduled command with a key.** The literature mostly sends time in as a message. The
Decider pattern treats time as an input: something outside sends a command when it is due.
Microsoft's CQRS Journey has its registration process send itself a delayed
`ExpireRegistrationProcess` command, keep that command's id in its state, and ignore one whose id
no longer matches. It works, and it shows the problem: the command was decided when it was sent,
not when it is due, so the process still needs state to tell a live expiry from a stale one. A
key to cancel or replace the command helps with the scheduler, not with that. And when the
command goes to an aggregate, that aggregate can only decide from its own events, so what the
process knew has to be copied into it as events that exist only to answer the command later.
Bounda keeps `delay` for what it is good at, *do this later* from a policy, and uses deadlines for
*this process expects something by then*.

**A durable timer in a workflow.** Temporal persists timers, so they survive downtime. A
`sleep()` cannot be moved, though: its documentation shows an updatable timer built from a
deadline variable that a signal changes and a condition waits on. That variable is a deadline in
state. Changing a duration in the code of running workflows can also break their replay, which is
why such changes are versioned.

The designs Bounda follows are the ones where time is a fact the state decides on. Mathias
Verraes' Passage of Time event makes the passing of time a domain event that each service judges
for itself; `ProcessDeadlineReached` is that event, per instance. A Cloudflare Durable Object has
a single alarm, and setting it replaces the previous one: one entry per instance at its earliest
deadline is the same shape, and on Cloudflare the store arms its alarm at the next entry due.

## What stays outside

- **Punctuality.** A deadline runs when the worker reaches it after its moment, never before, and
  waiting for the events stored before it is best effort, which is why `cancelOrder` refuses an
  order already paid: the aggregate has the last word.
- **Time in aggregates.** Only processes have deadlines. An aggregate that must expire is a
  process's job, or a policy's delayed command.
- **A failed process.** While an instance is failed its deadlines wait with its events, and run in
  their place when the failure is retried ([When a process fails](/concepts/when-a-process-fails/)).
- **Follow-ups beyond one hop.** What the follow-ups of a timeout cause finds the process ended.

## Where to read more

- [Deadlines](/guides/reacting-to-events/#deadlines), the rules in the terms of the handler's code,
  and [Processes](/guides/project-layout/#processes-processesname) for the file contract.
- [A step that never answers](/guides/sagas/#a-step-that-never-answers), the storefront's payment
  window and timeout as a saga.
- [Your event store is your outbox](/concepts/event-store-as-outbox/), for why a deadline's entry
  commits with the state it was computed from.
- Timer APIs: Axon's
  [deadline managers](https://docs.axoniq.io/axon-framework-reference/4.11/deadlines/deadline-managers/)
  and
  [`SimpleDeadlineManager`](https://apidocs.axoniq.io/4.13/org/axonframework/deadline/SimpleDeadlineManager.html),
  NServiceBus [saga timeouts](https://docs.particular.net/nservicebus/sagas/timeouts) and the
  [forum answer on extending one](https://discuss.particular.net/t/increase-timeout-of-saga-or-cancel-timeout-and-create-a-new-timeout/2884),
  Akka's
  [`TimerScheduler`](https://doc.akka.io/api/akka-core/current//akka/actor/TimerScheduler.html) and
  [timers after a restart](https://github.com/akka/akka/issues/30062),
  [a lost cancel in MassTransit](https://github.com/MassTransit/MassTransit/discussions/3347),
  Wolverine's [saga timeouts](https://wolverinefx.net/guide/durability/sagas.html), Temporal's
  [timers](https://docs.temporal.io/develop/typescript/timers) and
  [changing a duration](https://community.temporal.io/t/versioning-for-workflow-sleep-and-awaitwithtimeout-with-duration-change/6517).
- Time as a message: Jérémie Chassaing's
  [Decider](https://thinkbeforecoding.com/post/2021/12/17/functional-event-sourcing-decider), the
  CQRS Journey's
  [registration process](https://github.com/mspnp/cqrs-journey/blob/master/source/Conference/Registration/RegistrationProcessManager.cs),
  Mathias Verraes'
  [Passage of Time event](https://verraes.net/2019/05/patterns-for-decoupling-distsys-passage-of-time-event/),
  the Durable Object [alarm](https://developers.cloudflare.com/durable-objects/api/alarms/), and the
  [Process Manager](https://www.enterpriseintegrationpatterns.com/patterns/messaging/ProcessManager.html)
  in Enterprise Integration Patterns.
