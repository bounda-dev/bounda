---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Policies and processes can have collaborators, the way commands do, so a call to the outside
world can run after the events it reacts to are stored instead of inside a command handler that a
concurrency conflict reruns. A policy with collaborators is a directory,
`policies/<action>-on-<event>/index.ts`, with `<collaborator>.<implementation>.ts` files next to
it; in a process, those files sit in its directory and reach every handler, `on-timeout.ts`
included. Handlers receive them next to `event` and `commands`, typed from a `Collaborators`
export in `index.ts` or inferred from the implementations. `bounda.config.ts` picks an
implementation under `policies` and `processes`, by aggregate and then by key:
`policies: { order: { notifyOnOrderPlaced: { mailer: { use: "smtp" } } } }`.

`bounda generate` now rejects a collaborator named after an argument its handler already
receives (`event`, `commands`, `state`, `aggregateId`, `command`, `events`, `idempotencyKey`).

Breaking, for code that does not come from `bounda generate`: a registry's policies are entries
`{ module, collaborators? }` like commands, `ProcessEntry` gains `collaborators`, the
`CommandConfig` type is now `CollaboratorsConfig`, and `selectCollaborators` takes `owner` and
`path` instead of `commandName`. Run `bounda generate` to update generated files.
