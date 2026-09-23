---
"@bounda-dev/core": patch
"@bounda-dev/adapter-postgresql": patch
---

An app without policies or processes no longer runs a policy or process runner: nothing reads the
log for them, nothing checkpoints and nothing wakes up. On Cloudflare that removes an alarm and
two row writes after every command. A policy or process now always starts at the head of the log
when it has no checkpoint yet, so adding the first one to a running app does not replay its
history. `CheckpointStore` gains `remove(subscriber)`.
