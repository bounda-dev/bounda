---
"@bounda-dev/core": patch
---

A policy or process retried after dispatching a delayed command no longer leaves that command
scheduled twice. The commands a reaction dispatches now get ids derived from its idempotency key,
the command type and how many of that type the run dispatched before, so a retry that dispatches
the same commands gives them the same ids: a delayed one keeps its place in the scheduler, and a
command handler's `idempotencyKey` stays the same across the reaction's retries. A dead-letter
replay derives new ones.
