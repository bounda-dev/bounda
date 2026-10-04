---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": patch
---

Two replays of the same dead letter running at once no longer both commit. `deadLetters.replay`
checked that a command or policy letter was still `failed` before running it and then marked it
`replayed` unconditionally, so a double click, a retried CLI call, two instances or two Durable
Object calls interleaving each passed the check, and the command was decided twice. A discard
racing a replay could likewise turn a discarded letter into `replayed`. A letter's status now
changes only while it is `failed`: the replay or discard that gets there second rejects with the
new `DeadLetterSettledError` (code `DEAD_LETTER_SETTLED`), a policy's or a command's replay
refused that way writes nothing, and one that meets a conflict checks the letter again before
running its handler a second time. A replay or discard of a letter that was already replayed or
discarded rejects with `DeadLetterSettledError` too, instead of `ConfigurationError`, with the
same message as before.

For adapter authors, the `DeadLetterStore` port changes: `updateStatus` moves only a `failed`
letter and rejects with `DeadLetterSettledError` when the letter is missing or no longer `failed`,
instead of doing nothing or overwriting it.
