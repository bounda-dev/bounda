---
"@bounda-dev/core": patch
---

Every handler that can call the outside world receives `idempotencyKey`, to pass to providers that
deduplicate requests. In a command handler it is the command's id, which stays the same when a
concurrency conflict runs the handler again; a delayed command now keeps the id it was scheduled
with when the worker runs it, retries included. In policy and process handlers it is a UUID v5 of
the handler and the event (for `on-timeout.ts`, the process instance): the same on every automatic
retry, and new each time an operator replays the dead letter, so a provider that stored the failed
attempt's answer sees a new request.
