---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/adapter-sqlite": minor
"@bounda-dev/adapter-postgresql": minor
"@bounda-dev/adapter-cloudflare": minor
"@bounda-dev/react-router": minor
---

One name per concept across the public API, the CLI and the stored rows.

Breaking:

- A dead letter is retried, not replayed: `app.deadLetters.replay(id)` is `retry(id)`, the status
  `replayed` is `retried`, and `bounda dead-letters replay <id>` is `bounda dead-letters retry <id>`.
  On Cloudflare, the client's `deadLetters.replay` is `deadLetters.retry` and the object's RPC
  method `replayDeadLetter` is `retryDeadLetter`. Replay is kept for reprocessing history.
- "Subscriber" names only the group that keeps a checkpoint (`policies`, `processes`,
  `projection:<read model>`). The policy, process or scheduled command a dead letter or an inbox
  claim belongs to is its `handler`: `DeadLetter.subscriber` and the `subscriber` filter of
  `deadLetters.list` and `count` are `handler`, `bounda dead-letters list --subscriber` is
  `--handler`, `ClaimLostError.subscriber` is `handler`, and the `InboxLedger` port keys claims by
  `handler`. The `subscriber` column of the inbox and dead-letter tables is `handler`, and the
  `bounda.dead_letters` counter carries `bounda.handler` and `bounda.handler.kind` instead of
  `bounda.subscriber` and `bounda.subscriber.kind`, which stay on the dispatch span and the lag
  gauge.
- A command dispatched with `delay` is a scheduled command everywhere: its dead letters have kind
  `scheduled` instead of `command` (`--kind scheduled` in the CLI and on the counter) and the
  command type as their `handler` instead of `scheduled:<CommandType>`, the event written when one
  fails for good is `ScheduledCommandFailed` instead of `CommandFailed`, and an invalid payload
  is reported for a "scheduled command".
- `DeadLetterKind` no longer has `projection`: a projection never files a dead letter.
- A dead letter that cannot be retried in the app as it now is (its policy, process or scheduled
  command is gone from the registry, its policy or process no longer handles the event, or its
  process instance failed on another step) is refused with the new `DeadLetterNotRetriableError`
  (code `DEAD_LETTER_NOT_RETRIABLE`) without running anything. A policy that no longer reacts to
  the letter's event used to run anyway, and a scheduled command that no longer exists was
  refused with `NotFoundError`.
- `bounda dead-letters list` refuses a `--kind` or `--status` it does not know instead of listing
  nothing.
- `consistency: "immediate"` in `@bounda-dev/react-router` is `consistency: "read-your-writes"`,
  still the default, and `createBounda` throws `ConfigurationError` for a value it does not know.
- `processStreamId`, `ProcessStreamIdFunction` and `PROCESS_STREAM_PREFIX` are removed: nothing
  used them.
- The storage no longer adds columns to tables an earlier version created, and
  `storageSchemaAdditions` is gone from `@bounda-dev/core/adapter/sqlite` and
  `@bounda-dev/adapter-sqlite`: a database created before this version has to be created again.
