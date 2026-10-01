---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Collaborators belong to the aggregate. A port is a directory at the aggregate's root,
`order/notifier/`, whose `index.ts` exports its interface named after the directory
(`Notifier`) and whose other files implement it with a default export
(`order/notifier/smtp.ts`); every handler of the aggregate receives it, its commands, policies
and processes alike, so a call to the outside world can run in the policy or process that reacts
to a stored event instead of inside a command handler that a concurrency conflict reruns. The
`+types` of an implementation gives it the interface as `Implementation.Contract`, and the
generated registry checks each implementation against it, so one that does not fulfil the
contract fails `tsc`.

`bounda.config.ts` picks one implementation per port under `collaborators`, by aggregate and
port, with the file name as the value: `collaborators: { order: { notifier: "smtp" } }`. The
generator emits the type of that section and registers it with `@bounda-dev/core/register`, so
`defineConfig` rejects a name that does not exist and requires a choice wherever a port has
several implementations; a port with one may be left out, and no implementation is a default.

Breaking: a command or policy is always a file, the `<collaborator>.<implementation>.ts` files
next to a command, policy or process are gone, and so are the `commands`, `policies` and
`processes` sections of the configuration and the `Collaborators` type a module used to export;
`bounda generate` points at the aggregate root for each. In the registry, `collaborators` moves
from the command, policy and process entries to the aggregate entry, typed as
`CollaboratorModules`; `CollaboratorImplementations`, `InferCollaborators`,
`CollaboratorSelection` and `ReactionsConfig` are gone, `ImplementationModule` and
`CollaboratorsSection` are new, and `selectCollaborators` takes the aggregate. `bounda generate`
rejects a port named after a handler argument (`command`, `state`, `events`, `event`, `commands`,
`idempotencyKey`, `signal`, `aggregateId`, `after`), after an event of its aggregate, or
`commands`, `policies` or `processes`. Run `bounda generate` to update generated files.
