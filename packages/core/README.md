# @bounda-dev/core

The Bounda runtime: aggregates, commands, events, policies, processes and read models, wired from
the modules you write and the types the generator emits.

Bounda is an event sourcing and CQRS framework for TypeScript. Your business logic lives in small
files that export a handful of functions; the runtime does the wiring and runs on one database.

```bash
npm install @bounda-dev/core @bounda-dev/adapter-sqlite
npm install -D @bounda-dev/cli
```

A command handler returns the events to append. Its argument types come from a generated module
next to it, so nothing is registered by hand:

```ts
// app/domain/order/commands/place-order.ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), customerId: z.string().min(1), total: z.number().positive() });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "new") throw new DomainError("Already placed");
  return [events.orderPlaced(command.payload)];
};
```

`boot()` from `@bounda-dev/core/node` reads `bounda.config.ts` and the generated registry and
returns the running app, typed for your project. `createTestApp()` from
`@bounda-dev/core/testing` gives the same app on an in-memory adapter with a clock you control.

## Exports

| Subpath | Holds |
| --- | --- |
| `@bounda-dev/core` | The public API: `createApp`, errors, contracts, module and registry types |
| `@bounda-dev/core/config` | `defineConfig` and the configuration types |
| `@bounda-dev/core/node` | `boot()` and the console logger |
| `@bounda-dev/core/testing` | `createTestApp()` |
| `@bounda-dev/core/memory` | The in-memory adapter |
| `@bounda-dev/core/adapter` | Ports for writing an adapter |
| `@bounda-dev/core/adapter/sql` | Helpers shared by the SQL adapters |
| `@bounda-dev/core/register` | Where the generator registers your registry type |

## Alpha

Published under the `alpha` tag. The API can change between alphas without a deprecation cycle.

Docs: [docs.bounda.dev](https://docs.bounda.dev). Source and issues:
[github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
