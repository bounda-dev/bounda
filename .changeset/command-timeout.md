---
"@bounda-dev/core": minor
---

Command handlers now have a time limit and a `signal`. `runtime.commands.timeout` (30 seconds by
default, per aggregate in `overrides.<aggregate>.commands.timeout`) bounds each run of a handler:
past it, the dispatch rejects with `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it
returns is stored. Pass `signal` to what the handler calls outside (`fetch(url, { signal })`).
A command a policy or process dispatches also stops when that run times out or fails, and
`DispatchOptions` takes a `signal` with which the caller withdraws a command until its events
start being stored. A command handler that takes longer than 30 seconds, which used to pass, now
fails unless the timeout is raised.
