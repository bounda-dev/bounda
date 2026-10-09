---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

Fixes from a review of the generator, the registry checks and the CLI:

- A policy that exports no `on` reacts to the longest event of its aggregate that its key ends with after `On`, by one rule core exports as `policyTrigger` and `bounda generate` uses too. `put-on-hold-on-payment-failed` used to compile with one event and fail to boot with another, and every policy for an aggregate named `add-on` failed to boot. A policy that exports `on` is typed with any event of its aggregate, and `bounda generate` warns about one that exports no `on` and whose name gives no event, which boot refuses.
- Boot refuses a projection whose event, from its file name or its `on`, its aggregate does not have, as it already did for policies; `bounda generate` warns about such a file that exports no `on`.
- `bounda generate` refuses two commands, or two queries, with the same key across the app, and an aggregate or read model whose generated types meet others (`test`, `order-created` next to `order`). A module named like a reserved word (`delete`, `import`), `registry`, or like another of its owner no longer produces a registry that does not parse.
- State inference reads `begin` and `evolve` exported in a list (`export { evolve }`), and downgrades a field whose type is not visible on any of its lines.
- Boot refuses `readModels` and `runtime.overrides` keys the registry does not have, and `payload`, `repository`, `state` or `correlate` exports that are not functions.
- `rootDir` is gone from the configuration: nothing read it.
- `bounda generate --watch` ignores `.bounda` as well as `+types`, and no longer prints that it is watching after the watch failed. Ctrl+C stops every other command at once. `dead-letters list --limit` takes only a whole number, 0 or more.
- Generated files and read-model fingerprints are ordered by code unit, the same on every machine.
- With state to infer, `bounda generate` no longer writes `.bounda/types.ts` with every state unknown and then again inferred: TypeScript reads the first pass from memory, so the file is written once, or not at all when nothing changed, and editors and `tsc --watch` never see the intermediate one. `inferStates` takes `typesContent` instead of `write`.
