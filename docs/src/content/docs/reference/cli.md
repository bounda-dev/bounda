---
title: CLI
description: "The bounda command: generate the registry and the types, rebuild a read model, deal with dead letters."
sidebar:
  order: 0
---

`@bounda-dev/cli` installs the `bounda` command.

```bash
pnpm add -D @bounda-dev/cli typescript
```

TypeScript 7 or newer is an optional peer: the generator needs it only to infer the state of
aggregates without `state.ts`.

## `bounda generate`

Reads the project layout and writes `.bounda/registry.ts`, `.bounda/register.d.ts`, `.bounda/types.ts` and one
`+types/<name>.ts` next to every module. Files whose content did not change are left alone;
`+types` files whose module is gone are removed.

```bash
bounda generate
bounda generate --watch
bounda generate --root ./apps/shop --app-dir src --no-infer
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | current directory | The project root: where `.bounda/` goes and `tsconfig.json` is looked for |
| `--app-dir <dir>` | `app` | The application directory under the root, with `domain/` and `read/` |
| `--tsconfig <file>` | `<root>/tsconfig.json` | The TypeScript project used to infer state |
| `--no-infer` | | Do not start TypeScript; aggregates without `state.ts` get `UnknownState` |
| `--watch` | | Regenerate after each burst of changes under the application directory |

Output lists every file written or removed, then a summary:

```
  written  .bounda/registry.ts
  written  app/domain/order/+types/order-placed.ts
1 aggregate, 1 read model, 10 files (2 written, 8 unchanged, 0 removed)
```

Warnings from state inference go to stderr and do not change the exit code:

```
warning: order: field "cancellation" (set by orderCancelled) has a type that is not visible
from .bounda/types.ts (Cannot find name 'Cancellation'.); it is typed as unknown. Export the type
or add state.ts
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Generated, possibly with warnings |
| `1` | The layout breaks a convention. Every problem is listed with its path; nothing is written |
| `2` | Something else failed, such as a file where `.bounda/` should be |

### Watch mode

`--watch` regenerates after each burst of changes, 100 ms after the last one, and ignores changes
to `+types` directories. It starts watching before its first run, so a module saved while that run
is going is regenerated right after it, and prints `watching app/ for changes` once that run has
succeeded. A run that fails prints its problems and watching goes on; a first run that fails
outright, such as a file where `.bounda/` should be, ends it. `Ctrl-C` ends it too.

### How state is inferred

For an aggregate without `state.ts`, the generator writes a first pass in which the state is
`UnknownState`, opens the project with TypeScript, reads the return type of every event's `apply`
and unions the fields it finds. Each field is optional, since a fresh aggregate has none:

```ts
export type OrderState = {
  readonly customerId?: string;
  readonly lines?: readonly import("../app/domain/order/order-placed.ts").Line[];
  readonly status?: "cancelled" | "paid" | "placed";
};
```

Types exported from your modules are referenced through `import(...)`. A type that is not
exported cannot be named from `.bounda/types.ts`; that field becomes `unknown` and a warning says
which field and which events set it. Export the type, or add `state.ts`, to fix it. Without
TypeScript installed, or when it cannot open the project, the state stays `UnknownState` and the
warning says so.

## `bounda rebuild`

Rebuilds one read model from the whole stream without taking it offline. It loads
`bounda.config.ts` and the generated registry the way `boot()` does, so it runs from the project
root with the same environment as the app.

```bash
bounda rebuild orderSummary
bounda rebuild orderSummary --root ./apps/shop --config bounda.config.ts --registry .bounda/registry.ts
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--root <dir>` | current directory | The project root, where the configuration and `.bounda/` are |
| `--config <file>` | `bounda.config.ts` | The configuration module under the root |
| `--registry <file>` | `.bounda/registry.ts` | The generated registry module under the root |

The projections run into a fresh table with the view's current fields while queries keep reading
the live one. When the fresh table has caught up with the stream it takes the live table's place
and the read model's checkpoint is set to where the rebuild stopped, in one transaction that waits
for any projection batch in flight; the worker carries on from there, so every event reaches the
new table once. A projection that throws aborts the rebuild and leaves the live table as it was. A
rebuild that was interrupted resumes exactly where it stopped when you run it again, as long as
the read model's fields and projections are the same code; otherwise it starts over.

```
rebuilt read model "orderSummary": 48213 events, checkpoint at position 48213
```

Use it after fixing a projection, and when a view loses a field or changes a field's type, which
the app refuses to do on start. See [Deployment](/guides/deployment/#rebuilding-a-read-model) for
when to run it in a deploy. Exit codes: `0` rebuilt, `1` bad arguments, `2` the project could not
be loaded, the read model is not in the registry, or a projection failed.

## `bounda dead-letters`

Lists, replays or discards the handler runs that gave up. It boots the project the way `boot()`
does, without starting the background work, so it runs from the project root with the app's
environment.

```bash
bounda dead-letters list
bounda dead-letters list --kind policy --subscriber order.notifyOnOrderPlaced
bounda dead-letters list --status replayed --limit 20 --json
bounda dead-letters replay <id>
bounda dead-letters discard <id>
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--kind <kind>` | `list` | `policy`, `process` or `command` |
| `--status <status>` | `list` | `failed` (default), `replayed` or `discarded` |
| `--subscriber <name>` | `list` | The policy or process name as the letter records it, e.g. `order.notifyOnOrderPlaced`, or `scheduled:<CommandType>` |
| `--limit <n>` | `list` | At most this many letters |
| `--json` | `list` | Print the letters as JSON |
| `--root`, `--config`, `--registry` | all | As for `bounda rebuild` |

```
019a0c4e-3c9e-7a1b-9f1e-2b3c4d5e6f70  failed  policy  order.notifyOnOrderPlaced
    OrderPlaced on order:o-1, 1 attempt, last 2026-09-22T14:03:11.402Z (terminal)
    mail server rejects it
1 dead letter
```

`replay` runs the failed handler again and marks the letter `replayed` when it succeeds; if the
handler fails again its error is printed, the exit code is `2` and the letter stays `failed`. See
[Reacting to events](/guides/reacting-to-events/#dead-letters) for what a replay does per kind.

## Programmatic use

Everything the command does is exported from `@bounda-dev/cli`:

```ts
import { generate } from "@bounda-dev/cli";

const report = await generate({ root: process.cwd() });
report.written; // absolute paths written this run
report.warnings; // inference warnings, per aggregate
```

`discoverProject`, `emitProject`, `inferStates`, `watchProject` and `runCli` are the pieces
`generate` and the binary are made of. `bounda rebuild` is `rebuildReadModel` from
`@bounda-dev/core` over a project loaded with `loadProject` from `@bounda-dev/core/node`; an app
exposes the same as `app.rebuildReadModel(name)`. `bounda dead-letters` is `app.deadLetters` on
a booted app.
