---
"@bounda-dev/core": minor
---

The events a process's `at-timeout.ts` causes now reach the process's own handlers. Before, the
`OrderCancelled` it caused found the instance timed out and was dropped, so a compensation written
in `on-order-cancelled.ts` was skipped on a timeout and had to be written twice. `ProcessTimedOut`
now lists those events as `followUps`: the instance still ends as `timed_out` at once, but each
follow-up runs its handler with its own claim and retries, records `ProcessHandled`, and never
completes the process again. One that fails for good is dead-lettered without `ProcessFailed`, and
replaying its letter marks it replayed in the same transaction as what the handler writes. A
command sent with `delay`, or an event no handler of the process takes, is not a follow-up, and any
other event still finds the instance ended. A compensation moved from `at-timeout.ts` to the
handler of the event it causes no longer commits with the timeout: it runs afterwards, retries on
its own, and a failure leaves its letter without failing the process, which has ended.
