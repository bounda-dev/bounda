---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/adapter-postgresql": patch
"@bounda-dev/adapter-cloudflare": patch
---

Processes have deadlines, and a deadline is state. A field of a process `state` declared with
`deadline()` is a moment the process acts at: a handler schedules it by setting it with
`after("24h")`, moves it by changing it and cancels it with `null`, and `at-<field>.ts` runs when
it comes due (`nextReminder` runs `at-next-reminder.ts`). `instant()` declares a moment the process
only records. Both are `Instant`s, ISO 8601 strings in UTC; `asInstant` makes one for a test.
`after()`, which every process handler now receives, counts from what triggered the handler, the
event's time or the moment that came due, so a retry or a late run sets the same moment and a
daily chain catches up in order after an outage. Each deadline comes due once per moment, the
earliest first and the field name breaking a tie; none runs once the process has ended. A deadline
waits, for at most ten worker rounds, until the process runner has handled the events stored
before it, and `app.getLag()` counts the ones waiting in `waitingDeadlines`. A failing deadline is
retried with the process's retry settings, and one that gives up fails the process and is
dead-lettered as `deadline:<field>`; retrying it runs the deadline again. Commands a deadline
sends start a new chain, so a repeated reminder never reaches `maxChainDepth`. Boot refuses a
`deadline()` without its `at-` file and an `at-` file without its `deadline()`, naming the file.
The `+types` of every process handler now checks what the handler returns against the state
(`Process.ReturnCheck`), so a field of the wrong type, or a plain string for a deadline, no longer
compiles.

Breaking: the time-out handler is `at-timeout.ts`, typed `Process.DeadlineArgs`, instead of
`on-timeout.ts` and `Process.TimeoutArgs`; `bounda generate` says so for a file left behind. The
time-out now counts from the starting event's time. For code that does not come from
`bounda generate`, `ProcessEntry.timeout` is `ProcessEntry.deadlines.timeout`,
`ProcessTimeoutArgs` is gone in favour of `ProcessDeadlineArgs`, and `ProcessStateArgs` gains
`deadline` and `instant`. The process runner keeps one scheduler entry per instance,
`bounda.ProcessDeadline`, in place of `bounda.ProcessTimeout`, and records
`ProcessDeadlineReached` when a deadline comes due. For adapter authors, the `Scheduler` port gains
`defer`, which hands a claimed command back without counting an attempt, and `schedule` takes
`keepTimingOfSameCommand`, which leaves an entry that already holds the same command and context
as it is, a pending retry included. The Cloudflare client's
`getLag()` is typed with the new `AppLag`, `waitingDeadlines` included.
