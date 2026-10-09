---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Fixes from a review of the generator, the registry checks and the CLI:

- A policy's trigger is the longest event of the aggregate it reacts to that its name ends with after `-on-`, in core and in the generator alike. `put-on-hold-on-payment-failed` used to compile with one event and fail to boot with another, and every policy for an aggregate named `add-on` failed to boot. `bounda generate` warns about a policy whose name has `-on-` but ends with no event.
- Boot refuses a projection whose event, from its file name or its `on`, its aggregate does not have, as it already did for policies; `bounda generate` warns about such a file that exports no `on`.
- `bounda generate` refuses two commands, or two queries, with the same key across the app, and an aggregate or read model whose generated types meet others (`test`, `order-created` next to `order`). A module named like a reserved word (`delete`, `import`) or like another of its owner no longer produces a registry that does not parse.
- State inference reads `begin` and `evolve` exported in a list (`export { evolve }`), and downgrades a field whose type is not visible on any of its lines.
- Boot refuses `readModels` and `runtime.overrides` keys the registry does not have, and `payload`, `repository`, `state` or `correlate` exports that are not functions.
- `rootDir` is gone from the configuration: nothing read it.
- `bounda generate --watch` ignores `.bounda` as well as `+types`, and no longer prints that it is watching after the watch failed. Ctrl+C stops every other command at once. `dead-letters list --limit` takes only a whole number, 0 or more.
- Generated files and read-model fingerprints are ordered by code unit, the same on every machine.
