---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

Two retries of the same dead letter running at once no longer both commit. `deadLetters.retry`
checked that a scheduled command or policy letter was still `failed` before running it and then marked it
`retried` unconditionally, so a double click, a retried CLI call, two instances or two Durable
Object calls interleaving each passed the check, and the command was decided twice. A discard
racing a retry could likewise turn a discarded letter into `retried`. A letter's status now
changes only while it is `failed`: the retry or discard that gets there second rejects with the
new `DeadLetterSettledError` (code `DEAD_LETTER_SETTLED`), a policy's or a scheduled command's
retry refused that way writes nothing, and one that meets a conflict checks the letter again before
running its handler a second time. A retry or discard of a letter that was already retried or
discarded rejects with `DeadLetterSettledError` too, instead of `ConfigurationError`.

For adapter authors, the `DeadLetterStore` store changes: `updateStatus` moves only a `failed`
letter and rejects with `DeadLetterSettledError` when the letter is missing or no longer `failed`,
instead of doing nothing or overwriting it.
