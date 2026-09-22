---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
"@bounda-dev/adapter-sqlite": patch
"@bounda-dev/adapter-postgresql": patch
---

Dead letters get a way out. `app.deadLetters` lists, counts, replays and discards the handler
runs that gave up, and `bounda dead-letters list | replay <id> | discard <id>` does the same from
the command line. A replay runs the failed policy or process handler again for its stored event,
or dispatches the dropped scheduled command again; a process that had failed is back to `started`
with its timeout re-armed at the original deadline. Command dead letters now record the command's
payload, in a new nullable `payload` column the adapters add to existing databases on start.
