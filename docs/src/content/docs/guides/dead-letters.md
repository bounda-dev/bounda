---
title: Dead letters and failed processes
description: What happens to a handler run the runtime gave up on, how to retry or discard it, and how a failed process keeps its later events in order.
sidebar:
  order: 5
---

This page is about what an operator does with a run the runtime gave up on. When a run is retried
and when it gives up is in [retries and timeouts](/guides/reacting-to-events/#retries-and-timeouts);
why a failed process parks its events is in [When a process fails](/concepts/when-a-process-fails/).

## Retrying and discarding

A dead letter is a handler run the runtime gave up on: a policy or process handler that failed for
good, or a scheduled command that was dropped. The subscriber's checkpoint moved on without it, so
it is up to an operator to decide what happens to it. `bounda dead-letters` is that operator's tool:

```bash
bounda dead-letters list
bounda dead-letters retry 019a0c4e-…
bounda dead-letters discard 019a0c4e-…
```

`list` prints the failed letters, and its [options](/reference/cli/#bounda-dead-letters) narrow
it or print JSON for a script. `retry` runs the failed handler once more and marks
the letter `retried` if it succeeds; when it fails again the error is printed and the letter stays
`failed`. `discard` marks it `discarded` without running anything. Letters are never deleted by
these commands; they are the record of what happened.

What a retry runs, and when it marks the letter, depends on the kind:

| Kind | What the retry runs | Marked `retried` |
| --- | --- | --- |
| Policy | The handler again, for the stored event, with the event's correlation. The inbox is bypassed on purpose: it already says the handler ran, and you are asking for another run. | In the same transaction as what the run writes |
| Process | The handler again for the stored event, with the instance's current state, or for a deadline's letter (`deadline:<field>`) the handler of that deadline, with a new `idempotencyKey`; an event that completes the process completes it. Then the events parked behind the failure, in order, and the process is `started` again, its deadlines scheduled at their moments (one already past runs at once); see [a failed process](#a-failed-process). | Once the instance has drained what was parked; a retry cut short is taken up by retrying the same letter |
| Follow-up of a timed-out process | Its handler and nothing else: the process stays timed out, and a handler a deploy removed lets the event through. | In the same transaction as what the run writes |
| Scheduled command | The dropped command again, with the payload the letter recorded, its [personal fields](/guides/personal-data/#in-a-commands-payload) opened. A rejection settles the letter too: it is the aggregate's answer, logged as `command rejected`. | In the same transaction as what the run writes |

Two retries of one letter, or a retry and a discard, never both settle it, even when they run at
once: whichever gets there second is refused with `DeadLetterSettledError`
(`DEAD_LETTER_SETTLED`). A retry marked in the same transaction as its writes stores nothing when it
is refused, so a double click does not store a command's decision twice, though the handler may
have run in both; a process's retry has already handled its events by then. A letter the app as
it now is cannot retry is refused with `DeadLetterNotRetriableError` (`DEAD_LETTER_NOT_RETRIABLE`)
without running anything: its policy, process or scheduled command is gone from the registry, its
policy or process no longer handles the event, its instance failed on another step whose letter
comes first, or the person whose data its scheduled command holds was forgotten since.

The same operations are on the app as `app.deadLetters` — `list`, `count`, `get`, `retry` and
`discard` — for a script or an admin route.

One kind of letter the runtime retries itself: those of a person whose [processing was
restricted](/guides/personal-data/#restricting-processing), `errorCode: "PROCESSING_RESTRICTED"`
with the person in `person`. `unrestrict` schedules a run of the worker that retries them in the
order of `list`, each as `retry` would, in its own transaction, so a crash leaves the rest to the
next run. A letter that fails again for good is written again under the same id, as that
failure's letter, with its `attempts` counted up, and stays `failed` for you; one that fails in a
way worth retrying is left as it was and the run is retried; one refused because the person was
restricted again waits for the next lift. A letter the app cannot retry is
logged and left as it is.

## What a letter holds

A letter records what gave up and why: its `kind` and `handler`, the event it was about (or the
dropped command, with its payload), how many `attempts` were made and when, the `errorType`, and
the error itself as `errorName` (its class, `ValidationError`) and `errorCode` (its
[code](/reference/errors/), when it is one of Bounda's), with its `errorMessage` and `errorStack`.

The message of an error a handler throws may quote what the handler read of a person: `cannot mail
ana@example.com`. So a letter also names the `person` its work was about, the one the event names
for a policy or process letter and the one the command's payload names for a scheduled command,
and stores the message and the stack encrypted with that person's key, as a
[personal field](/guides/personal-data/) is. A letter that names nobody keeps them in the clear:
a process deadline's, a policy's or process's for an event without personal fields, or whose
fields were forgotten before the handler read them, and a scheduled command's whose payload holds
no marked field. `app.deadLetters` and `bounda dead-letters list` open them for you. Once the
person is forgotten, even while the handler was failing, the letter stays, with its name and code,
and the message and the stack read as `null`: the process can still be retried, and the stream
still says it failed. `ProcessFailed` and `ScheduledCommandFailed` name the error
the same way, `errorName` and `errorCode`, and never carry its text.

## A failed process

A process fails when one of its handlers fails for good: the instance records `ProcessFailed`, the
run is dead-lettered, and the instance stops. Events keep arriving for it, and dropping them would
lose them: the `OrderPaid` that comes while the process is failed on a reminder is exactly the one
it must not miss. So the instance parks them. Each event that would do something in it (it has a
handler, or completes the process) is recorded in the instance's stream as `ProcessEventParked`, in
the order it arrived, and nothing of the process runs for that instance meanwhile, deadlines
included; every other instance of the process carries on. A follow-up of a timed-out process is the
exception: the process has ended, so its failure is only dead-lettered, and retrying the letter runs
the handler again.

Retrying the dead letter of the failure is what brings the instance back:

1. the failed handler runs again;
2. the parked events are handled one by one, in order, with the same `idempotencyKey` each would
   have had; a deadline that came due before a parked event arrived runs before it, as it would
   have if the process had not failed;
3. once none is left the instance records `ProcessResumed`, is `started` again, and its deadlines
   are scheduled again.

A failure whose handler a deploy has since removed, an event's or a deadline's, is let through, and
the retry goes on with what is parked. When the failure is the process's `timeout`, retrying it ends
the process as timed out and drops what is parked, as for any timed-out instance; what its
`at-timeout.ts` causes still reaches its handlers.

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

Parking starts when the failure is final. While a step is still waiting for a retry, the process is
handed none of its later events, whatever their instance, so a long back-off holds every instance
of the process for as long.

