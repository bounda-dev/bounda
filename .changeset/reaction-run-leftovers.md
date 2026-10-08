---
"@bounda-dev/core": patch
"@bounda-dev/cli": minor
---

A policy or process run that fails no longer leaves its scheduled commands behind, and one that runs
out of time no longer keeps dispatching commands.

- When a handler throws, times out, or its outcome cannot be recorded, the scheduled commands that
  run scheduled are cancelled. A retry that takes another path used to leave them in the scheduler,
  where they ran when due, even after the reaction was dead-lettered.
- When a handler runs out of time, the commands it dispatches from then on are refused with an
  error whose `code` is `REACTION_ABANDONED` and whose `cause` is the timeout. Before, the
  abandoned handler kept running and its commands kept going out.
- Policy, process and deadline handlers receive `signal`, an `AbortSignal` that aborts when their
  run times out or fails: pass it to calls outside (`fetch(url, { signal })`) so they stop too.
  `bounda generate` reserves the name, so a port can no longer be called `signal`.
