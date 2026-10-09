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

- **`after()` counts from what triggered the handler**: the event's time in an `on-<event>.ts`,
  the moment that came due in an `at-<field>.ts`. A retry, or a handler that runs late, sets the
  same moment, and a daily reminder does not drift. After an outage a chain catches up: every
  missed reminder runs in turn, soonest first.
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
- **Nothing runs once the process has ended**, whether it completed or timed out, but for the
  events its `at-timeout.ts` caused (below), nor while it is failed: its deadlines wait, like its
  events, for the failure to be retried.
- **A failure is handled like an event handler's**: it is retried with the process's back-off, and
  one that fails for good or runs out of attempts fails the process and is dead-lettered. Losing a
  race with another write to the instance does not count as an attempt.
- **The commands a deadline sends start a new chain**, so a reminder repeated every day for months
  never reaches `maxChainDepth`.

The time a process may stay open is a deadline too, `timeout`, set from `config.timeout` when the
process starts. Its handler is `at-timeout.ts`, which receives the same arguments, and reaching it
ends the process as timed out, with what the handler returns merged into the final state. Boot refuses a `deadline()`
without its `at-` file, an `at-` file without its `deadline()`, and a `deadline()` named `timeout`.

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

**Every reaction runs at least once.** Before running a handler the runtime claims
`(policy, eventId)` — or the process equivalent — in an inbox ledger. A claim that already
completed is not run again, so a retry after a crash mid-handler does not send the email twice.
What it cannot know is whether the side effect of a partially finished handler happened, which is
why a handler that talks to the outside world should be written so that running it twice is
harmless.

**An attempt writes everything or nothing.** The commands a policy or process handler dispatches
are decided on the spot but stored only when the attempt ends, together, in one transaction of
the store: the events of its immediate commands, its scheduled commands, the claim that marks the
event done and, when the runtime gives up, the dead letter. A process step adds its own lifecycle
events (`ProcessStarted`, `ProcessHandled`, `ProcessCompleted`, `ProcessDeadlineReached`,
`ProcessTimedOut`, `ProcessFailed`) and its next deadline's entry to the same transaction, so a deadline can never
disagree with the state it was computed from. A handler that throws, runs out of time or dies
before that leaves no command behind, immediate or scheduled, and the next attempt decides afresh.
When the instance moved meanwhile, because a deadline or another instance wrote to it, the step
runs again on the instance as it now is, without spending an attempt; it first starts its claim's
lease again, and stops there if another instance has taken the claim over. What
`await commands.x()` returns is the aggregate's decision, not something stored yet: call the outside world before
dispatching, not after, and pass `idempotencyKey`, because the attempt may run again. What stays
outside the promise, and why, is in [Your event store is your outbox](/concepts/event-store-as-outbox/):
the outside calls, the claim, and what a read model shows a handler.

**Every reaction gets an idempotency key.** Policy and process handlers receive
`idempotencyKey`, a UUID that is the same on every automatic retry of the handler for one event
(for an `at-` handler, for one deadline at one moment) and new each time an operator retries the
dead letter, so a provider that stored the failed attempt's answer sees a new request. Pass it to the providers that
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
nothing reads the global stream for them, nothing checkpoints and nothing wakes up. A deploy that removes
the last policy, or the last process, leaves their checkpoint where it was: an instance still
running the previous code goes on from there, and policies brought back later resume from that
point too, so they also react to what happened while they were gone.

**Failures are classified.** A terminal failure is dead-lettered at once; a retriable one is
retried on later passes with the configured back-off and dead-lettered when the attempts run out.
Dead letters keep the event, the handler, the error and the number of attempts, and they have a
way out: see [Dead letters](#dead-letters).

## What a command answers

`await commands.x()` in a policy or process resolves with what the command answered, and
`rejected` says which answer it is:

- `rejected: false` and `scheduled: false`: the aggregate decided, with its `version` and the
  `eventIds` and `eventTypes` it decided, in order;
- `rejected: false` and `scheduled: true`: a command with `delay`, with when it runs in
  `executeAt`. A call with `delay` is typed with this answer alone, since a scheduled command is
  rejected, if at all, when it runs; a call without `delay` is typed without it;
- `rejected` set to a code: the command's handler rejected it with one of the codes its module
  declares in [`rejections`](/guides/project-layout/#rejections), and `message` says why. Nothing
  was decided.

`rejected` is typed by the codes the command declares, and is only ever `false` for a command
without `rejections`, so comparing it with a code it never answers does not compile. A handler
that compensates looks at it; one that does not changes nothing, and the run goes on:

```ts
const paid = await commands.markOrderPaid({ orderId: aggregateId });
if (paid.rejected === "NotOpen") {
  await commands.cancelPayment({ paymentId: event.aggregateId, reason: "order no longer open" });
}
```

A rejection nobody looks at is logged (`command rejected`, at `info`) and recorded on the
command's span; a test asserts the ones it expects from what
[`runUntilIdle()`](/guides/testing/#rejections) returns. A scheduled command that is rejected when it
runs changes nothing in the same way. While the run lasts, only a failure rejects the `await`: a
payload that does not validate, a concurrency conflict that outlasts its retries, an error the handler throws. The run
fails with it, and the runtime retries it or dead-letters it (see [Retries and timeouts](#retries-and-timeouts)).

## Calling the outside world

A command handler decides; it does not act on the world. It can run more than once for one
command, when its append loses a concurrency race, and what it decided is not stored until the
append succeeds. So a command handler only makes calls that are safe to repeat and harmless if the
decision never lands: reading a price, checking stock, creating a payment intent with its
`idempotencyKey` so the page can show the payment form. What it learned from outside goes into the
event, so the history says what the decision was based on. Those calls take the handler's
`signal` (`fetch(url, { signal })`), which aborts when the handler runs out of time, so a provider
that hangs fails the command instead of holding the request (see
[Retries and timeouts](#retries-and-timeouts)).

The effect itself (charging the card, sending the email, telling the warehouse) goes in a policy
or process that reacts to the stored event, through one of the aggregate's ports. It runs
after the commit and at least once, and it reports back with a command:

```ts
// policies/charge-on-order-placed.ts
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
decision. When a later step fails and an effect that already happened has to be undone, the
reaction compensates it: see [Sagas and compensation](/guides/sagas/).

A few rules keep it correct:

- **Await the commands the handler dispatches.** The run waits for every one before it commits,
  awaited or not, within the handler's time, and one that fails fails the run, even if the handler
  catches its error; one the handler withdraws with its own `signal` does not. Awaiting is what
  keeps them in order, so a second command sees what the first decided, and what gives the
  handler their answers. A command dispatched once the run has finished, from a timer or a promise
  the handler left behind, is not part of it: it is refused (the error's `code` is
  `REACTION_FINISHED`) and logged at `error`, and decides nothing.
- **Pass `idempotencyKey` to every provider that takes one.** It is one key per handler run, and
  the handler passes it as it is, even when the run causes two effects:
  - Two effects on **different providers** (charging the card, sending the receipt) go in a
    reaction each. Each gets its own key, and a failing email does not charge the card again.
  - Two calls to **one provider** (a refund and a new charge) go behind one port method,
    whose implementation derives a key per call with `idempotencyKeyFor` from
    `@bounda-dev/core`. Each key is the same on every retry and a UUID like the handler's, so it
    fits the provider's length limit:

    ```ts
    // app/domain/order/infrastructure/payments/stripe.ts
    import { type CreateImplementation, idempotencyKeyFor } from "@bounda-dev/core";
    import Stripe from "stripe";
    import type { Payments } from "../../payments.ts";

    export const create: CreateImplementation<Payments> = ({ env }) => {
      const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      return {
        replaceCharge: async ({ chargeId, amount, idempotencyKey }) => {
          await stripe.refunds.create(
            { charge: chargeId },
            { idempotencyKey: idempotencyKeyFor(idempotencyKey, "refund") },
          );
          await stripe.charges.create(
            { amount, currency: "eur" },
            { idempotencyKey: idempotencyKeyFor(idempotencyKey, "charge") },
          );
        },
      };
    };
    ```
- **An id the run creates comes from its key.** The key a provider receives stays as it is, but
  the id of an aggregate the run starts (a payment, a shipment) is derived from it in the handler,
  `idempotencyKeyFor(idempotencyKey, "payment")`, one name per id, never `randomUUID()`. A retry
  then dispatches the same command with the same payload, so the provider gets the command's own
  key with the same parameters again. A random id would send it that key with other parameters,
  which a provider such as Stripe refuses.
- **Without a key on the provider's side**, look the operation up by your own reference before
  calling again, and give a process a time-out for a provider that may never answer.
- **The command a reaction dispatches can arrive twice**, when the reaction is retried after
  dispatching it. The retry gives it the same id, so a scheduled command stays scheduled once and
  the command's own `idempotencyKey` does not change, but one that already ran runs again: its
  handler decides from state and returns no events the second time, as `recordConfirmationSent`
  does in the [storefront example](/guides/storefront-example/).
- **A run that fails leaves no command behind**, immediate or scheduled, whether a policy's or a
  process step's: they are stored only when the attempt commits (see
  [what the runtime promises](#what-the-runtime-promises)), so a retry that decides differently
  starts from nothing. A crash mid-run leaves nothing either, only the claim, which expires with
  its lease.

### Keeping an external index

A search index in Typesense, Elasticsearch or Algolia is a read model in another store, but it is
not a projection: a projection commits with its checkpoint in one transaction of the read model's
database, which a call to another service cannot join ([why](/guides/project-layout/#ports-of-a-read-model)).
Feed it from a policy instead, through a port of the aggregate whose events it indexes. The policy
runs at least once and may run late, so each write is an upsert by id that carries the event's
`version`, the aggregate's own count of its events, and the index keeps a document only when that
version is newer than the one it has:

```ts
// app/domain/order/policies/index-order.ts
import type { Policy } from "./+types/index-order";

export const on = ["OrderPlaced", "OrderPaid", "OrderCancelled"];

export const handler = async ({ event, searchIndex }: Policy.HandlerArgs) => {
  await searchIndex.upsert({
    id: event.aggregateId,
    version: event.version,
    fields: { status: event.type, at: event.timestamp },
  });
};
```

Elasticsearch does the comparison itself with `version_type=external`; with a store that cannot,
the implementation reads the stored version first. An index over two aggregates is a policy and a
port in each, whose implementations share the client from outside `app/domain`.

## Retries and timeouts

Defaults, when the configuration says nothing:

| | Policies | Processes |
| --- | --- | --- |
| Strategy | exponential | exponential |
| Attempts | 3 | 3 |
| Base delay | 1s | 1s |
| Maximum delay | 30s | 30s |

Three different things are called a timeout, and it is worth keeping them apart:

- **How long one command handler run may take** is `runtime.commands.timeout`, 30 seconds by
  default. Past it the dispatch rejects (the error's `code` is `HANDLER_TIMEOUT`), the handler's
  `signal` aborts and nothing it returns is stored. Each retry after a concurrency conflict gets a
  time limit of its own; loading the aggregate and storing its events do not count. A command
  dispatched from a policy or process also stops when that run times out or fails, and a
  scheduled command that times out is retried like any other failure. Whoever dispatches can
  withdraw it sooner with a signal of their own, `commands.x(payload, { signal })`, until its
  events start being stored.
- **How long one policy or process handler run may take** is `runtime.policies.timeout`, 30
  seconds by default; the process runner reads the policy setting. When a run runs out of time,
  its commands still running stop and those it dispatches from then on are refused and logged at
  `warn` (the error's `code` is `REACTION_ABANDONED`, its `cause` the timeout), and the handler's
  `signal` aborts.
  JavaScript cannot stop the handler itself, so pass `signal` to what it calls outside
  (`fetch(url, { signal })`) and that stops too.
- **How long a process may stay open** before `at-timeout.ts` runs is the process's own `timeout`
  in its `config`, falling back to `runtime.processes.timeout`, 7 days by default.

Change them per app, or per aggregate:

```ts
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL! }),
  runtime: {
    commands: { timeout: "10s" },
    policies: { retry: { strategy: "exponential", maxAttempts: 5, maxDelay: "2m" } },
    processes: { timeout: "30d" },
    overrides: {
      order: { commands: { timeout: "1m" }, policies: { retry: { strategy: "none" } } },
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
bounda dead-letters retry 019a0c4e-…
bounda dead-letters discard 019a0c4e-…
```

`list` prints the failed letters, with `--kind policy|process|scheduled`, `--handler`,
`--status`, `--limit` and `--json` to narrow or script it. `retry` runs the failed handler once
more and marks the letter `retried` if it succeeds: for a policy or a scheduled command, in the
same transaction as what the run writes, so a retry that ran but could not be marked leaves
nothing behind, and so for a follow-up of a timed-out process; for any other process letter, once
its instance has drained what was parked, since a retry cut short there is taken up again by
retrying the same letter. When it fails again the error is printed and the letter stays `failed`.
A letter the app as it now is cannot retry (its policy, process or scheduled command is gone from
the registry, its policy or process no longer handles the event, or its instance failed on another
step whose letter comes first) is refused with `DeadLetterNotRetriableError`
(`DEAD_LETTER_NOT_RETRIABLE`) without running anything.
`discard` marks it `discarded` without running anything. Two retries of one letter, or a retry and
a discard, never both settle it, even when they run at once: whichever gets there second is
refused with `DeadLetterSettledError` (`DEAD_LETTER_SETTLED`). A retry marked in its own
transaction (a policy's, a scheduled command's or a follow-up's) refused that way stores nothing,
so a double click does not store a command's decision twice, though the handler may have run in
both; any other process's has already handled its events by then. Letters are never deleted by
these commands; they are the record of what happened.

What a retry does depends on the kind:

- **Policy**: the handler runs again for the stored event, with the event's correlation. The
  inbox ledger is bypassed on purpose: it already says the handler ran, and you are asking for
  another run.
- **Process**: the handler runs again for the stored event with the instance's current state, or,
  for a letter of a deadline (`deadline:<field>`), the handler of the deadline the process failed
  on, with a new `idempotencyKey`. An event that completes the process completes it. Then the
  events parked behind the failure are handled in order, and once none is left the process is
  back to `started`, its deadlines scheduled again at their moments (one already past runs at
  once); see [a failed process](#a-failed-process). The letter of a follow-up of a timed-out
  process runs its handler and nothing else: the process stays timed out, and a handler a deploy
  removed lets the event through.
- **Scheduled**: the dropped command is dispatched again with the payload the letter recorded. A
  command its aggregate now rejects settles the letter as `retried`, as the scheduler would have
  settled it: a rejection is the aggregate's answer, logged as `command rejected`, not a failure.

The same operations are on the app as `app.deadLetters` — `list`, `count`, `get`, `retry` and
`discard` — for a script or an admin route.

## A failed process

A process fails when one of its handlers fails for good: the instance records `ProcessFailed`, the
run is dead-lettered, and the instance stops. Events keep arriving for it, and dropping them
would lose them: the `OrderPaid` that comes while the process is failed on a reminder is exactly
the one it must not miss. So the instance parks them. Each event that would do something in it
(it has a handler, or completes the process) is recorded in the instance's stream as
`ProcessEventParked`, in the order it arrived, and nothing of the process runs meanwhile,
deadlines included. A follow-up of a timed-out process is the exception: the process has ended,
so its failure is only dead-lettered, and retrying the letter runs the handler again.

Retrying the dead letter of the failure is what brings the instance back:

1. the failed handler runs again;
2. the parked events are handled one by one, in order, with the same `idempotencyKey` each would
   have had; a deadline that came due before a parked event arrived runs before it, as it would
   have if the process had not failed;
3. once none is left the instance records `ProcessResumed`, is `started` again, and its deadlines
   are scheduled again.

A failure whose handler a deploy has since removed, an event's or a deadline's, is let through,
and the retry goes on with what is parked. When the failure is the process's `timeout`, retrying it ends the process as
timed out and drops what is parked, as for any timed-out instance; what its `at-timeout.ts` causes
still reaches its handlers.

An event that arrives during the retry is parked too and handled before the instance resumes, so
nothing overtakes an older event. If a parked event fails again, for whatever reason, it becomes
the new failure at once: it is dead-lettered without retries, the instance stays failed, and the
events after it stay parked until that letter is retried. A parked event the process no longer
handles, after a deploy removed its handler, is let through. A parked event that completes the
process completes it, and what is parked after it is dropped, as for any completed instance.

`bounda dead-letters list` says how many events wait behind a failure (`3 events are parked behind
it`), and so does `parked` on the letters of `app.deadLetters`. Discarding the letter gives the
instance up: it stays failed, its parked events never run, though they stay in its history, and
the events that reach it afterwards are dropped, as for an instance that has ended.

The failure is state as well: `ProcessFailed` names its dead letter (`letterId`), and the two are
written in the same transaction, with the claim of the event that failed. A failure that could
not be written leaves nothing, and the handler runs again once its claim's lease expires. The
same holds for each step of a retry: the retried handler, each parked event or deadline drained
and the final `ProcessResumed` are one transaction each, so a retry cut short goes on from the
last step written on the next retry.

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

A scheduled command is claimed by one instance at a time, however many are running the worker
role. Its run and the release of its claim are one transaction: what the command wrote lands
together with the claim's completion, so a worker that dies between the two does not run it twice,
and a command the worker gives up on is dead-lettered in the same transaction that drops it. The
claim's lease starts again before every retry after a conflict, and a command the worker reaches
too late in a batch goes back unrun, without counting an attempt. A run that stalls past its lease
anyway can lose the command to another instance, which then decides it; the stalled run writes
nothing, and stops before running the handler again. The same holds for a delayed policy's run and
for a process deadline.

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

`app.getLag()` reports how far behind the head of the global stream each subscriber is. Zero
means every consequence of every stored event has happened; a number that keeps growing means a
subscriber is failing and retrying. In tests, [asserting it is zero](/guides/testing/) proves nothing was left pending.
