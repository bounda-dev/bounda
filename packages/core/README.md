# @bounda-dev/core

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcore)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=core)

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

## Operating

The runtime carries what a production app needs to recover from its own mistakes, and the
`bounda` CLI exposes it: `bounda rebuild <read-model>` projects the stream into a fresh table and
swaps it in without taking the read model offline; `bounda dead-letters` lists, replays or
discards the handler runs that gave up; an `<event>.upcast.ts` next to an event brings stored
payloads of an older shape up to date as they are read. Every command, batch and handler run is
an OpenTelemetry span with `bounda.correlation_id`, the lag of every subscriber is a gauge, and on
PostgreSQL the dispatcher is woken by `NOTIFY` instead of polling. Snapshots are not there yet, on
purpose; the [deployment guide](https://docs.bounda.dev/guides/deployment/) says why.

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

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev](https://docs.bounda.dev). Source and issues:
[github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
