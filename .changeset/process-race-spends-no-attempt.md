---
"@bounda-dev/core": patch
---

A process event handler no longer spends an attempt when another write to its instance, such as a
deadline coming due, gets there before its `ProcessHandled`. The handler runs again on the
instance as it now is, up to `runtime.commands.concurrencyRetries` times, before the race counts
as a failed attempt; before, a few such races in a row could dead-letter the event and fail the
process although its handler never failed.
