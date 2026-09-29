---
title: Reacting to events
description: When a policy is enough, when the work needs a process, and what the runtime promises either way.
sidebar:
  order: 5
---

Two things react to events. A **policy** answers one event with commands and remembers nothing. A
**process** follows one aggregate instance over time, keeps state between events and can give up
when a deadline passes. [Project layout](/guides/project-layout/) has the file contract for both;
this page is about which one to reach for and what the runtime guarantees once you do.

## Which one

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
handler returns the next state:

```ts
export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderFulfilled, events.order.OrderCancelled],
  timeout: "72h",
});

export const state = ({ z }: Process.StateArgs) =>
  z.object({ autoFulfilled: z.boolean().default(false) });
```

If you find a policy reading a read model to decide what to do, that is a process asking to be
written: the state it needs belongs to the process, not to a projection it happens to share with
the UI.

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
export const handler = ({ state, after }: Process.HandlerArgs) => ({
  ...state,
  nextReminder: after("24h"),
  paymentDeadline: after("72h"),
});

// processes/order-payment/on-order-paid.ts
import { asInstant } from "@bounda-dev/core";

export const handler = ({ state, event }: Process.HandlerArgs) => ({
  ...state,
  paidAt: asInstant(event.timestamp),
  nextReminder: null,
  paymentDeadline: null,
});

// processes/order-payment/at-next-reminder.ts
export const handler = async ({ state, aggregateId, commands, after }: Process.DeadlineArgs) => {
  await commands.sendReminder({ orderId: aggregateId });
  return {
    ...state,
    reminders: state.reminders + 1,
    nextReminder: state.reminders < 2 ? after("24h") : null,
  };
};

// processes/order-payment/at-payment-deadline.ts
export const handler = async ({ state, aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "unpaid" });
  return { ...state, paymentDeadline: null, nextReminder: null };
};
```

`instant()` declares a moment the process only records, such as `paidAt`; nothing runs for it.
Both are ISO 8601 strings in UTC, typed `Instant`; `asInstant` makes one from a date or a string,
for a handler or a test. Use `deadline()` as it is: wrapped in `.describe()`, `.optional()` or the
like it no longer counts as a deadline, and boot says so when its `at-` file is there.

How deadlines behave:

- **`after()` counts from what triggered the handler**: the event's time in an `on-<event>.ts`,
  the moment that came due in an `at-<field>.ts`. A retry, or a handler that runs late, sets the
  same moment, and a daily reminder does not drift. After an outage a chain catches up: every
  missed reminder runs in turn, soonest first.
- **Each deadline comes due once at each moment.** When several are due, the earliest runs first
  and the field name breaks a tie; a moment already past runs at once. The handler returns the
  field as `null` or another moment: leaving it at the moment that came due fails the process.
- **A deadline waits for the events stored before it.** The worker holds a deadline that came due
  until the process runner has handled every event stored by then, so an `OrderPaid` stored a
  second before the payment deadline clears it first. When the process runner is stuck, the
  deadline runs anyway after ten rounds of the worker, and `app.getLag()` counts it in
  `waitingDeadlines` meanwhile. This is best effort: the aggregate that receives the command still
  decides, so `cancelOrder` refuses an order that is already paid.
- **Nothing runs once the process has ended**, whether it completed or timed out, nor while it is
  failed: its deadlines wait, like its events, for the failure to be replayed.
- **A failure is handled like an event handler's**: it is retried with the process's back-off, and
  one that fails for good or runs out of attempts fails the process and is dead-lettered. Losing a
  race with another write to the instance does not count as an attempt.
- **The commands a deadline sends start a new chain**, so a reminder repeated every day for months
  never reaches `maxChainDepth`.

The time a process may stay open is a deadline too, `timeout`, set from `config.timeout` when the
process starts. Its handler is `at-timeout.ts`, which receives the same arguments, and reaching it
ends the process as timed out with the state the handler returns. Boot refuses a `deadline()`
without its `at-` file, an `at-` file without its `deadline()`, and a `deadline()` named `timeout`.

A deadline is not a delay. `delay` on a command or a policy says *do this later*; a deadline says
*this process expects something by then*, and it lives in the process's history: the state holds
it, `ProcessDeadlineReached` records that it came due.

## What the runtime promises

**Every reaction runs at least once.** Before running a handler the runtime claims
`(policy, eventId)` — or the process equivalent — in an inbox ledger. A claim that already
completed is not run again, so a retry after a crash mid-handler does not send the email twice.
Nor is one the runtime gave up on: the claim records the give-up before the dead letter is written,
so a crash in between leaves the next delivery to write the dead letter, not to run the handler.
What it cannot know is whether the side effect of a partially finished handler happened, which is
why a handler that talks to the outside world should be written so that running it twice is
harmless.

**Every reaction gets an idempotency key.** Policy and process handlers receive
`idempotencyKey`, a UUID that is the same on every retry of the handler for one event (for an
`at-` handler, for one deadline at one moment) and new each time an operator replays the dead letter, so a
provider that stored the failed attempt's answer sees a new request. Pass it to the providers that
accept one:

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
nothing reads the log for them, nothing checkpoints and nothing wakes up.

**Failures are classified.** A terminal failure is dead-lettered at once; a retriable one is
retried on later passes with the configured back-off and dead-lettered when the attempts run out.
Dead letters keep the event, the handler, the error and the number of attempts, and they have a
way out: see [Dead letters](#dead-letters).

## Calling the outside world

A command handler decides; it does not act on the world. It can run more than once for one
command, when its append loses a concurrency race, and what it decided is not stored until the
append succeeds. So a command handler only makes calls that are safe to repeat and harmless if the
decision never lands: reading a price, checking stock, creating a payment intent with its
`idempotencyKey` so the page can show the payment form. What it learned from outside goes into the
event, so the history says what the decision was based on.

The effect itself (charging the card, sending the email, telling the warehouse) goes in a policy
or process that reacts to the stored event, with the collaborator next to it. It runs after the
commit and at least once, and it reports back with a command:

```ts
// policies/charge-on-order-placed/index.ts
export const handler = async ({ event, commands, payments, idempotencyKey }: Policy.HandlerArgs) => {
  const charge = await payments.charge({ amount: event.payload.total, idempotencyKey });
  if (charge.ok) {
    await commands.recordPayment({ orderId: event.aggregateId, chargeId: charge.id });
  } else {
    await commands.recordPaymentFailure({ orderId: event.aggregateId, reason: charge.reason });
  }
};
```

A refusal from the provider is an answer, not an error: it becomes an event (`PaymentFailed`) that
other reactions can respond to. Throw only when there is no answer, and the runtime retries with
back-off. The event store is the outbox, so nothing else is needed for the effect to follow the
decision.

A few rules keep it correct:

- **Pass `idempotencyKey` to every provider that takes one.** It is one key per handler run: two
  different calls in one handler need two keys, so either derive a second one for the provider
  (`${idempotencyKey}-refund`, if its length limit allows) or give each effect its own reaction.
- **Without a key on the provider's side**, look the operation up by your own reference before
  calling again, and give a process a time-out for a provider that may never answer.
- **The command a reaction dispatches can arrive twice**, when the reaction is retried after
  dispatching it. The retry gives it the same id, so a delayed command stays scheduled once and
  the command's own `idempotencyKey` does not change, but one that already ran runs again: its
  handler decides from state and returns no events the second time, as `recordConfirmationSent`
  does in the [storefront example](/guides/storefront-example/).
- **A run that fails takes its delayed commands back.** When the handler throws, times out, or
  its outcome cannot be recorded, the delayed commands that run scheduled are cancelled, so a
  retry that decides differently leaves none behind. Its immediate commands have already run.
  Only a crash of the runtime mid-run leaves a delayed command in place.

## Retries and timeouts

Defaults, when the configuration says nothing:

| | Policies | Processes |
| --- | --- | --- |
| Strategy | exponential | exponential |
| Attempts | 3 | 3 |
| Base delay | 1s | 1s |
| Maximum delay | 30s | 30s |

Two different things are called a timeout, and it is worth keeping them apart:

- **How long one handler run may take** is `runtime.policies.timeout`, 30 seconds by default. It
  governs process handlers too, not only policies — the process runner reads the policy setting.
  When a run runs out of time, the commands it dispatches from then on are refused and the
  handler's `signal` aborts. JavaScript cannot stop the handler itself, so pass `signal` to what
  it calls outside (`fetch(url, { signal })`) and that stops too.
- **How long a process may stay open** before `at-timeout.ts` runs is the process's own `timeout`
  in its `config`, falling back to `runtime.processes.timeout`, 7 days by default.

Change them per app, or per aggregate:

```ts
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  runtime: {
    policies: { retry: { strategy: "exponential", maxAttempts: 5, maxDelay: "2m" } },
    processes: { timeout: "30d" },
    overrides: {
      order: { policies: { retry: { strategy: "none" } } },
    },
  },
});
```

`strategy: "none"` dead-letters on the first failure, which is what you want for a policy whose
command can never succeed on a second try.

`maxChainDepth`, 25 by default, bounds how far a chain of policies reacting to the events of other
policies may go before the runtime refuses to continue. Hitting it means two policies are
answering each other.

## Dead letters

A dead letter is a handler run the runtime gave up on: a policy or process handler that failed
for good, or a scheduled command that was dropped. The stream moved on without it, so it is up to
an operator to decide what happens to it. `bounda dead-letters` is that operator's tool:

```bash
bounda dead-letters list
bounda dead-letters replay 019a0c4e-…
bounda dead-letters discard 019a0c4e-…
```

`list` prints the failed letters, with `--kind policy|process|command`, `--subscriber`,
`--status`, `--limit` and `--json` to narrow or script it. `replay` runs the failed handler once
more and marks the letter `replayed` if it succeeds; when it fails again the error is printed and
the letter stays `failed`. `discard` marks it `discarded` without running anything. Letters are
never deleted by these commands; they are the record of what happened.

What a replay does depends on the kind:

- **Policy**: the handler runs again for the stored event, with the event's correlation. The
  inbox ledger is bypassed on purpose: it already says the handler ran, and you are asking for
  another run.
- **Process**: the handler runs again for the stored event with the instance's current state, or,
  for a letter of a deadline (`deadline:<field>`), the handler of the deadline the process failed
  on, with a new `idempotencyKey`. An event that completes the process completes it. Then the
  events parked behind the failure are handled in order, and once none is left the process is
  back to `started`, its deadlines scheduled again at their moments (one already past runs at
  once); see [a failed process](#a-failed-process).
- **Command**: the dropped command is dispatched again with the payload the letter recorded.

The same operations are on the app as `app.deadLetters` — `list`, `count`, `get`, `replay` and
`discard` — for a script or an admin route.

## A failed process

A process fails when one of its handlers fails for good: the instance records `ProcessFailed`, the
run is dead-lettered, and the instance stops. Events keep arriving for it, and dropping them
would lose them: the `OrderPaid` that comes while the process is failed on a reminder is exactly
the one it must not miss. So the instance parks them. Each event that would do something in it
(it has a handler, or completes the process) is recorded in the instance's stream as
`ProcessEventParked`, in the order it arrived, and nothing of the process runs meanwhile,
deadlines included.

Replaying the dead letter of the failure is what brings the instance back:

1. the failed handler runs again;
2. the parked events are handled one by one, in order, with the same `idempotencyKey` each would
   have had; a deadline that came due before a parked event arrived runs before it, as it would
   have if the process had not failed;
3. once none is left the instance records `ProcessResumed`, is `started` again, and its deadlines
   are scheduled again.

A failure whose handler a deploy has since removed, an event's or a deadline's, is let through,
and the replay goes on with what is parked. When the failure is the process's `timeout`, replaying it ends the process as
timed out and drops what is parked, as for any timed-out instance.

An event that arrives during the replay is parked too and handled before the instance resumes, so
nothing overtakes an older event. If a parked event fails again, for whatever reason, it becomes
the new failure at once: it is dead-lettered without retries, the instance stays failed, and the
events after it stay parked until that letter is replayed. A parked event the process no longer
handles, after a deploy removed its handler, is let through. A parked event that completes the
process completes it, and what is parked after it is dropped, as for any completed instance.

`bounda dead-letters list` says how many events wait behind a failure (`3 events are parked behind
it`), and so does `parked` on the letters of `app.deadLetters`. Discarding the letter gives the
instance up: it stays failed, its parked events never run, though they stay in its history, and
the events that reach it afterwards are dropped, as for an instance that has ended.

The failure is state as well: `ProcessFailed` carries its dead letter, so a letter whose writing
was cut short is filed again the next time the process runner reaches the instance: an event for
it, a retry of the deadline that failed, or a replay.

This is Axon's sequenced dead-letter queue, which parks the events of one sequence behind the one
that failed, with the process instance as the sequence.

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

A scheduled command is taken by exactly one instance, however many are running the worker role.

## Delaying a policy

A delayed command decides later; a delayed policy acts later. When the effect itself has to wait,
as in *send the welcome email a minute after the user registers*, the policy exports `delay`:

```ts
// policies/send-welcome-email-on-user-registered/index.ts
export const delay = asDuration(process.env.WELCOME_EMAIL_DELAY ?? "1m");

export const handler = async ({ event, commands, emailSender, idempotencyKey }: Policy.HandlerArgs) => {
  await emailSender.send({ to: event.payload.email, name: event.payload.name }, idempotencyKey);
  await commands.recordWelcomeEmailSent({ userId: event.aggregateId, to: event.payload.email });
};
```

When the event is read, the runtime schedules the policy's run instead of running it, due at the
event's time plus the delay, so a worker that falls behind does not push it later. When it comes
due, the worker reads the event, upcast to its shape at that moment, and runs the handler with
everything a live run gets: collaborators, the commands facade, the same `idempotencyKey`, the
aggregate's retry settings and time budget. A run that fails for good is dead-lettered as the
policy's, and replaying it runs the handler at once. Delayed runs are not ordered among
themselves: the worker retries each one on its own, so the run for a later event can overtake an
earlier one that is waiting for its retry.

A delayed policy runs whatever happened in between. When the effect depends on what happened
since (*remind the customer unless they paid*), delay a command instead: its handler decides
against the state at that moment, as `sendReminder` does above. A pending run lives in the
scheduler, not in the event history; the command the handler dispatches is what records that the
effect happened.

## Watching it work

`app.getLag()` reports how far behind the stream each subscriber is. Zero means every consequence
of every stored event has happened; a number that keeps growing means a subscriber is failing and
retrying. In tests, [asserting it is zero](/guides/testing/) proves nothing was left pending.
