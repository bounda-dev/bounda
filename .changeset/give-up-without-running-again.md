---
"@bounda-dev/core": patch
---

A policy or process handler whose last attempt failed no longer runs once more when recording
that failure (its dead letter, or the process's `ProcessFailed`) was cut short: the next delivery
records it without running the handler again. A policy's dead letter is now logged and counted
before its inbox claim is completed, as a process's already was.
