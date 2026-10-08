---
"@bounda-dev/cli": minor
---

The root of an aggregate holds more than its events. A module there is an event when it exports
`payload`, `begin` or `evolve` and nothing else at run time; a port when `infrastructure/` holds a
directory named after it; and anything else, a value object, a domain service or a helper, file
or directory, is left to the handlers that import it, with no `_` in front. A module that exports
an event's function next to anything else is reported, and `bounda generate` warns about a module
that imports its own `+types` without exporting an event's function (an event that lost its
`evolve` to a typo or still exports `apply`) and about a directory one letter away from one it
reads, or named `command`, `policy`, `process` or `infra`, whose modules would go unregistered.

Breaking: a read model can no longer share its name with an aggregate, since the configuration
groups ports by module name. `report.warnings` from `generate` holds both kinds as
`GenerateWarning`, `{ module, message }`, instead of the inference warning's `aggregate`.
