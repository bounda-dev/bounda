---
title: CLI
description: "The bounda command: generate the registry and the types, once or on every change."
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

Reads the project layout and writes `.bounda/registry.ts`, `.bounda/types.ts` and one
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
1 aggregate, 1 read model, 9 files (2 written, 7 unchanged, 0 removed)
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
to `+types` directories. A run that fails prints its problems and watching goes on. `Ctrl-C` ends
it.

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

## Programmatic use

Everything the command does is exported from `@bounda-dev/cli`:

```ts
import { generate } from "@bounda-dev/cli";

const report = await generate({ root: process.cwd() });
report.written; // absolute paths written this run
report.warnings; // inference warnings, per aggregate
```

`discoverProject`, `emitProject`, `inferStates`, `watchProject` and `runCli` are the pieces
`generate` and the binary are made of.
