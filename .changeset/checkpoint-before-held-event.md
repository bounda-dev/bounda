---
"@bounda-dev/core": patch
---

When a policy or a process holds an event (a retry waiting for its back-off, or a claim another
instance has), the checkpoint now advances past the events of the batch before it instead of
holding the whole batch. Those events are no longer redelivered on every pass while the retry
waits, and the lag counts only the events from the held one on.
