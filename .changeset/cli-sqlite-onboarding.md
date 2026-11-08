---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/sqlite": patch
---

The CLI keeps standard output to a command's result: the app's log lines, the access log records, progress and the console go to standard error, so `bounda dead-letters list --json` pipes cleanly. `--actor <id>` on `rebuild`, `dead-letters list`, `retry` and `discard`, and `forget` names who runs the command, as `client.as(actor)` does. In core, `createConsoleLogger({ stream })` writes every level to the stream given, `rebuildReadModel` and `app.as(actor).rebuildReadModel` name the actor in their log lines, and `app.forgetAgain(entries, { actor })` records it on each `PersonalDataForgotten`. A SQLite file not in WAL mode yet, such as one just restored, no longer fails with `SQLITE_BUSY` when several processes open it at once: the switch to WAL tries again for `SQLITE_BUSY_TIMEOUT_MS`.
