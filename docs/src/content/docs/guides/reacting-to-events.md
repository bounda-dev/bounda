---
title: Reacting to events
description: When a policy is enough, when the work needs a process, and what the runtime promises either way.
sidebar:
  order: 2
---

Two things react to events. A **policy** answers one event with commands and remembers nothing. A
**process** follows one aggregate instance over time, keeps state between events and can give up
when a deadline passes. [Project layout](/guides/project-layout/) has the file contract for both;
this page is about which one to reach for and what the runtime guarantees once you do.
[Calling the outside world](/guides/calling-the-outside-world/) is about the effects a reaction
causes, and [dead letters](/guides/dead-letters/) about the runs that fail for good.

## Which one

| What the reaction needs | Use | Example |
| --- | --- | --- |
| To answer one event, remembering nothing | a policy | send the confirmation for this order |
| Memory between events, or a deadline | a process | cancel the order if it is not paid within 72 hours |
| To decide later, against the state then | a [scheduled command](#delaying-a-command) | remind the customer a day later, unless they paid |
| To act later, whatever happened since | a [delayed policy](#delaying-a-policy) | send the welcome email a minute after the user registers |

Use a **policy** when the answer to the event does not depend on anything that happened before:
send the confirmation for this order, schedule the reminder, tell the warehouse. Each one is a
file whose name says what it reacts to, and the handler gets the event and the commands facade:

```ts
export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.sendReminder({ orderId: event.aggregateId }, { delay: "24h" });
};
```

Use a **process** when the decision needs memory or a deadline: *cancel the order if it is not
fulfilled within 72 hours*, *stop chasing once the customer paid*, *count the reminders already
sent*. The process declares what opens it, what closes it and how long it may stay open, and each
handler returns the fields of its state that change:

```ts
export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderFulfilled, events.order.OrderCancelled],
  timeout: "72h",
});

export const state = ({ z }: Process.StateArgs) =>
  z.object({ autoFulfilled: z.boolean().default(false) });
```

What a handler returns is merged over the state, and returning nothing keeps it as it is. The
merge is shallow: a nested object is replaced whole. A field goes back to its default only when
the handler sets it, as in `{ paymentId: null }`; one returned as `undefined` keeps its value. A
field the state does not declare does not compile, so a misspelt one is not dropped in silence.

If you find a policy reading a read model to decide what to do, that is a process asking to be
written: the state it needs belongs to the process, not to a projection it happens to share with
the UI.

## Which instance an event reaches

A process instance is one instance of its aggregate: `order-payment` for order `o-1` is one
instance, and an event reaches the instance its aggregate id names. An event of another aggregate
names it with the main aggregate's id field in its payload, or through `correlate`
([the file contract](/guides/project-layout/#processes-processesname)).

- An event that does not start the process and finds no open instance is skipped, and so is any
  event for an instance that has completed or timed out, except what its `at-timeout.ts` caused. A
  starting event never reopens one.
- An event for an instance that has failed is parked instead, and handled in order once the
  failure is retried; see [a failed process](/guides/dead-letters/#a-failed-process).
- A correlator that throws, or returns anything but an id or `null`, dead-letters that event for
  the process, and the rest carry on.

The state a handler returns is parsed with `state`: defaults fill what is missing, keys the schema
does not declare are dropped, and a state it refuses fails the handler for good, like any other
terminal error. The compiler checks it first: the `+types` of every handler asserts that what it
returns fits the state, so a field of the wrong type, or a plain string where a deadline wants an
`Instant`, is a type error reported in that `+types` file.

## Deadlines

A process that has to act at a moment keeps the moment in its state. A field declared with
`deadline()` is a deadline: `null` while nothing is due, and a moment once a handler sets it with
`after()`. Changing the value moves it, `null` cancels it, and there is no schedule or cancel call
besides. Each deadline has a handler named after it, `at-<field>.ts`, which runs when it comes
due:

```ts
// processes/order-payment/index.ts
export const state = ({ z, deadline, instant }: Process.StateArgs) =>
  z.object({
    reminders: z.int().default(0),
    nextReminder: deadline(),
    paymentDeadline: deadline(),
    paidAt: instant(),
  });

// processes/order-payment/on-order-placed.ts
export const handler = ({ after }: Process.HandlerArgs) => ({
  nextReminder: after("24h"),
  paymentDeadline: after("72h"),
});

// processes/order-payment/on-order-paid.ts
import { asInstant } from "@bounda-dev/core";

export const handler = ({ event }: Process.HandlerArgs) => ({
  paidAt: asInstant(event.timestamp),
  nextReminder: null,
  paymentDeadline: null,
});

// processes/order-payment/at-next-reminder.ts
export const handler = async ({ state, aggregateId, commands, after }: Process.DeadlineArgs) => {
  await commands.sendReminder({ orderId: aggregateId });
  return {
    reminders: state.reminders + 1,
    nextReminder: state.reminders < 2 ? after("24h") : null,
  };
};

// processes/order-payment/at-payment-deadline.ts
export const handler = async ({ aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "unpaid" });
  return { paymentDeadline: null, nextReminder: null };
};
```

`instant()` declares a moment the process only records, such as `paidAt`; nothing runs for it.
Both are ISO 8601 strings in UTC, typed `Instant`; `asInstant` makes one from a date or a string,
for a handler or a test. Use `deadline()` as it is: wrapped in `.describe()`, `.optional()` or the
like it no longer counts as a deadline, and boot says so when its `at-` file is there.

How deadlines behave:

- **The state is the only record.** Each instance has one scheduler entry, at its earliest pending
  deadline, written with the state it comes from. When it comes due the runtime loads the instance
  and works out from its state what is due, so an entry the state no longer backs runs nothing.
- **`after()` counts from what triggered the handler**: the event's time in an `on-<event>.ts`,
  the moment that came due in an `at-<field>.ts`. A retry, or a handler that runs late, sets the
  same moment, and a daily reminder does not drift. After an outage a chain catches up: every
  missed reminder runs in turn, soonest first. A deploy that changes `"72h"` changes the instances
  that set the deadline afterwards, not the moments already stored.
- **Each deadline comes due once at each moment.** When several are due, the earliest runs first
  and the field name breaks a tie; a moment already past runs at once. The handler returns the
  field as `null` or another moment: one that leaves it out does not compile, and one that sets it
  back to the moment that came due fails the process.
- **A deadline waits for the events stored before it.** The worker holds a deadline that came due
  until the process runner has handled every event stored by then, so an `OrderPaid` stored a
  second before the payment deadline clears it first. When the process runner is stuck, the
  deadline runs anyway after ten rounds of the worker, and `app.getLag()` counts it in
  `waitingDeadlines` meanwhile. This is best effort: the aggregate that receives the command still
  decides, so `cancelOrder` refuses an order that is already paid.
- **Nothing runs once the process has ended**, whether it completed or timed out, except the
  events its `at-timeout.ts` caused (below), nor while it is failed: its deadlines wait, like its
  events, for the failure to be retried.
- **A failure is handled like an event handler's**: it is retried with the process's back-off, and
  one that fails for good or runs out of attempts fails the process and is dead-lettered. Losing a
  race with another write to the instance does not count as an attempt.
- **The commands a deadline sends start a new chain**, so a reminder repeated every day for months
  never reaches `maxChainDepth`.

The time a process may stay open is a deadline too, `timeout`, set from `config.timeout` when the
process starts. Its handler is `at-timeout.ts`, which receives the same arguments, and reaching it
ends the process as timed out, with what the handler returns merged into the final state. A
`deadline()` and its `at-` file come in pairs, and none is named `timeout`
([what boot refuses](/reference/conventions/#what-boot-refuses)).

The events the commands of `at-timeout.ts` cause still reach the process's own handlers: an
`OrderCancelled` it causes runs `on-order-cancelled.ts` as any other would, once the process has
ended, so a compensation written once, where the cancellation is handled, runs however the
process ends. `ProcessTimedOut` lists them as `followUps`, and only they get through: each runs
with its own claim and retries, never completes the process again, and one that fails for good is
dead-lettered without failing the process, which has ended already. A command sent with `delay`,
or an event no handler of the process takes, or one that starts it, is not a follow-up. A
follow-up's handler sees the state the timeout left, with what earlier follow-ups changed, and a
deadline it sets never comes due. Follow-ups go one hop only: what their own commands cause finds
the process ended, so compensate in the handler of the event `at-timeout.ts` causes, not further
down a chain. Like any process event, a follow-up that fails retriably holds the events after it
until its retry.

A deadline is not a delay. `delay` on a command or a policy says *do this later*; a deadline says
*this process expects something by then*, and it lives in the process's history: the state holds
it, `ProcessDeadlineReached` records that it came due.

## What the runtime promises

**Every reaction runs at least once, with an inbox.** Before running a handler the runtime
claims `(handler, event)` in an inbox ledger. A claim that already completed is not run again, so
an event that was handled is not handled twice. A handler that crashes midway has not completed
its claim and runs again, and the runtime cannot know whether its side effect happened, which is
why a handler that talks to the outside world should be written so that running it twice is
harmless.

**An attempt writes everything or nothing.** The commands a handler dispatches are decided on the
spot but stored only when the attempt ends, in one transaction with the mark that says the event is
done, and for a process step with its lifecycle events and its next deadline. A handler that throws,
runs out of time or dies before that leaves no command behind, and the next attempt decides afresh.
What `await commands.x()` returns is the aggregate's decision, not something stored yet: call the
outside world before dispatching, not after, and pass `idempotencyKey`, because the attempt may run
again. [Your event store is your outbox](/concepts/event-store-as-outbox/#what-one-attempt-is) lists
what the transaction holds, how the claim and its lease work, and what stays outside.

**Every reaction gets an idempotency key.** Policy and process handlers receive `idempotencyKey`, a
UUID that is the same on every automatic retry of the handler for one event (for an `at-` handler,
for one deadline at one moment) and new each time an operator retries the dead letter, so a provider
that stored the failed attempt's answer sees a new request. Pass it to the providers that accept
one:

```ts
export const handler = async ({ event, payments, idempotencyKey }: Policy.HandlerArgs) => {
  await payments.charge({ orderId: event.aggregateId, idempotencyKey });
};
```

**Events stay in order.** While a retry is pending the subscriber's checkpoint stops right before
the event, so the policy's next event waits for this one instead of overtaking it; the other
policies go on with the rest of the batch. A policy stuck on a retry therefore delays the events
after it and shows up as lag rather than as events silently processed out of order. A delayed
policy only keeps this order while its runs are scheduled; the runs themselves can overtake one
another (see [Delaying a policy](#delaying-a-policy)).

**Reactions start when they are deployed.** A policy or process reacts to the events stored
after the code that declares it starts, never to the history before it. Adding the first policy
to an app that has been running for months does not replay months of events into it; adding one
more next to others behaves the same way, because they share the policy runner's checkpoint. An
app with no policies has no policy runner at all, and one with no processes no process runner:
nothing reads the global stream for them, nothing checkpoints and nothing wakes up. A deploy that removes
the last policy, or the last process, leaves their checkpoint where it was: an instance still
running the previous code goes on from there, and policies brought back later resume from that
point too, so they also react to what happened while they were gone.

**Failures are classified.** A terminal failure is dead-lettered at once; a retriable one is
retried on later passes with the configured back-off and dead-lettered when the attempts run out.
Dead letters keep the event, the handler, the error and the number of attempts, and they have a
way out: see [Dead letters](/guides/dead-letters/).

## What a command answers

`await commands.x()` in a policy or process resolves with what the command answered, and
`rejected` says which answer it is. Every answer carries `aggregateType` and `aggregateId`:

| `rejected` | `scheduled` | Also carries | What happened |
| --- | --- | --- | --- |
| `false` | `false` | `version`, `eventIds`, `eventTypes` | The aggregate decided these events, in order |
| `false` | `true` | `executeAt` | A command with `delay` was scheduled to run then |
| a code | | `message` | The handler rejected it with a code its module declares in [`rejections`](/guides/project-layout/#rejections); nothing was decided |

A call with `delay` is typed with the scheduled answer alone, since a scheduled command is
rejected, if at all, when it runs; a call without `delay` is typed without it.

`rejected` is typed by the codes the command declares, and is only ever `false` for a command
without `rejections`, so comparing it with a code it never answers does not compile. A handler
that compensates looks at it; one that does not changes nothing, and the run goes on:

```ts
const paid = await commands.markOrderPaid({ orderId: aggregateId });
if (paid.rejected === "NotOpen") {
  await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
}
```

A rejection nobody looks at is logged (`command rejected`, at `info`) and recorded on the command's
span; a test asserts the ones it expects from what
[`runUntilIdle()`](/guides/testing/#rejections-inside-reactions) returns. A scheduled command that
is rejected when it runs changes nothing in the same way. While the run lasts, only a failure
rejects the `await`: a payload that does not validate, a concurrency conflict that outlasts its
retries, an error the handler throws, or a `DomainError` the command did not make with its own
`reject`, such as one rethrown from another command, which fails it with `FOREIGN_REJECTION`. The
run fails with it, and the runtime retries it or dead-letters it (see
[Retries and timeouts](#retries-and-timeouts)).

## Retries and timeouts

A policy or process run that fails runs again, waiting longer each time, up to three runs in all,
before it becomes a dead letter; [Configuration](/reference/configuration/#retry) has every setting
and its default.

Four different things are called a timeout, and it is worth keeping them apart:

| What it bounds | Setting | When it runs out |
| --- | --- | --- |
| One run of a command handler | `runtime.commands.timeout` | The dispatch rejects with `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it returns is stored |
| One run of a policy handler | `runtime.policies.timeout` | The run fails; its commands still running stop, later ones are refused with `REACTION_ABANDONED` and logged at `warn`, and its `signal` aborts |
| One run of a process handler, for an event or a deadline | `runtime.processes.handlerTimeout` | As for a policy |
| How long a process stays open | the process's `config.timeout`, else `runtime.processes.timeout` | `at-timeout.ts` runs and the process ends as timed out |

For a command, each retry after a concurrency conflict gets a time limit of its own, and loading
the aggregate and storing its events do not count. A command dispatched from a policy or process
also stops when that run times out or fails, and a scheduled command that times out is retried
like any other failure. Whoever dispatches can withdraw a command sooner with a signal of their
own, `commands.x(payload, { signal })`, until its events start being stored.

JavaScript cannot stop a handler itself, so a reaction that runs out of time keeps running until
it returns: pass `signal` to what it calls outside (`fetch(url, { signal })`) and that stops too.

Each can be set per app under `runtime`, or for one aggregate under `runtime.overrides`; a policy
whose command can never succeed on a second try takes `retry: { strategy: "none" }`.
[Configuration](/reference/configuration/#runtime) has every key and default, `maxChainDepth`
included, which stops two policies that answer each other.

## Delaying a command

A policy can put a command in the future; in a process, reminders and expiries are
[deadlines](#deadlines) instead:

```ts
await commands.sendReminder({ orderId: event.aggregateId }, { delay: "24h" });
```

The compiler checks a literal duration. For one that comes from the environment, `asDuration`
checks it at the call site and returns it typed:

```ts
import { asDuration } from "@bounda-dev/core";

await commands.sendReminder(
  { orderId: event.aggregateId },
  { delay: asDuration(process.env.REMINDER_DELAY ?? "24h") },
);
```

A scheduled command's payload is stored as JSON and validated in that form when it is dispatched,
so what would fail when it runs fails at once: a `z.date()` field rejects the string JSON turns a
date into, so declare it as `z.coerce.date()`. The handler receives the payload validated when the
command runs, so a schema's transforms apply once.

A scheduled command is claimed by one instance at a time, however many are running the worker
role, and its run commits with the release of its claim, as a reaction's attempt does
([what that means](/concepts/event-store-as-outbox/#what-one-attempt-is)). A command the worker
reaches too late in a batch goes back unrun, without counting an attempt. The same holds for a
delayed policy's run and for a process deadline.

## Delaying a policy

A scheduled command decides later; a delayed policy acts later. When the effect itself has to wait,
as in *send the welcome email a minute after the user registers*, the policy exports `delay`:

```ts
// policies/send-welcome-email-on-user-registered.ts
export const delay = asDuration(process.env.WELCOME_EMAIL_DELAY ?? "1m");

export const handler = async ({ event, commands, emailSender, idempotencyKey }: Policy.HandlerArgs) => {
  await emailSender({ to: event.payload.email, name: event.payload.name, idempotencyKey });
  await commands.recordWelcomeEmailSent({ userId: event.aggregateId, to: event.payload.email });
};
```

When the event is read, the runtime schedules the policy's run instead of running it, due at the
event's time plus the delay, so a worker that falls behind does not push it later. When it comes
due, the worker reads the event, upcast to its shape at that moment, and runs the handler with
everything a live run gets: ports, the commands facade, the same `idempotencyKey`, the
aggregate's retry settings and time budget. A run that fails for good is dead-lettered as the
policy's, and retrying it runs the handler at once. Delayed runs are not ordered among
themselves: the worker retries each one on its own, so the run for a later event can overtake an
earlier one that is waiting for its retry.

A delayed policy runs whatever happened in between. When the effect depends on what happened
since (*remind the customer unless they paid*), delay a command instead: its handler decides
against the state at that moment, as `sendReminder` does above. A pending run lives in the
scheduler, not in the event history; the command the handler dispatches is what records that the
effect happened.

## Watching it work

`app.getLag()` reports how far behind the head of the global stream each subscriber is. Zero means
every consequence of every stored event has happened; a number that keeps growing means a subscriber
is failing and retrying. In tests, [asserting it is zero](/guides/testing/#nothing-left-behind)
proves nothing was left pending.
