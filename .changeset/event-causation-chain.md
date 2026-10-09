---
"@bounda-dev/core": minor
---

An event now leads to the event that caused it. Its `metadata.causationId` is what caused the
command that wrote it: for a command a policy or a process dispatched, the event that reaction ran
for; for a command from outside, the command itself, as before. The command that wrote the event
moves to the new `metadata.commandId`, absent on the events the runtime writes itself. Commands are
not stored, so a `causationId` that named a command used to end the chain in the event store.

Breaking: code that read `metadata.causationId` as the command that wrote an event reads
`metadata.commandId`.
