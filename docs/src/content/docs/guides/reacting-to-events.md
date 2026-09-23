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
  await commands.sendConfirmation({ orderId: event.aggregateId });
};
```

Use a **process** when the decision needs memory or a deadline: *cancel the order if it is not
fulfilled within 72 hours*, *stop chasing once the customer paid*, *count the reminders already
sent*. The process declares what opens it, what closes it and how long it may stay open, and each
handler returns the next state:

```ts
export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.OrderPlaced],
  completedBy: [events.OrderFulfilled, events.OrderCancelled],
  timeout: "72h",
});

export const state = ({ z }: Process.StateArgs) =>
  z.object({ autoFulfilled: z.boolean().default(false) });
```

If you find a policy reading a read model to decide what to do, that is a process asking to be
written: the state it needs belongs to the process, not to a projection it happens to share with
the UI.

## What the runtime promises

**Every reaction runs at least once.** Before running a handler the runtime claims
`(policy, eventId)` — or the process equivalent — in an inbox ledger. A claim that already
completed is not run again, so a retry after a crash mid-handler does not send the email twice.
What it cannot know is whether the side effect of a partially finished handler happened, which is
why a handler that talks to the outside world should be written so that running it twice is
harmless.

**Events stay in order.** While a retry is pending the subscriber's checkpoint holds, so the next
event waits for this one instead of overtaking it. A policy stuck on a retry therefore delays the
policies behind it and shows up as lag rather than as events silently processed out of order.

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

## Retries and deadlines

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
- **How long a process may stay open** before `on-timeout.ts` runs is the process's own `timeout`
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
- **Process**: the handler runs again for the stored event with the instance's current state. A
  process that had failed is back to `started`, its timeout is re-armed at the original deadline
  (or right now, if that is already past), and an event that completes the process completes it.
- **Command**: the dropped command is dispatched again with the payload the letter recorded. A
  dropped process timeout runs the process's `on-timeout.ts` if the process is still open.

The same operations are on the app as `app.deadLetters` — `list`, `count`, `get`, `replay` and
`discard` — for a script or an admin route.

## Delaying a command

A policy can put a command in the future, which is how reminders and expiries are written:

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

## Watching it work

`app.getLag()` reports how far behind the stream each subscriber is. Zero means every consequence
of every stored event has happened; a number that keeps growing means a subscriber is failing and
retrying. In tests, [asserting it is zero](/guides/testing/) proves nothing was left pending.
