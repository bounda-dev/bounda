---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": patch
---

An event folds into its aggregate's state through `evolve`, the name the Decider pattern gives that
function, and the event that opens the aggregate exports `begin`. `create` and `apply` are common
names for a factory or a domain service, so they stay free for the modules that sit next to the
events.

Breaking: rename `apply` to `evolve` in every event. `Event.ApplyArgs` becomes `Event.EvolveArgs`,
`EventApplyArgs` becomes `EventEvolveArgs`, and `EventModule` takes `begin` and `evolve`. Run
`bounda generate` to update generated files.
