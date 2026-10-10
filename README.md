<p align="center">
  <a href="https://bounda.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/public/wordmark-dark.svg" />
      <img src="docs/public/wordmark-light.svg" alt="Bounda" width="200" />
    </picture>
  </a>
</p>

<p align="center">Event sourcing and CQRS for TypeScript without the ceremony.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bounda-dev/core"><img src="https://img.shields.io/npm/v/@bounda-dev/core?style=flat&label=npm&color=b07114" alt="npm version" /></a>
  <a href="https://github.com/bounda-dev/bounda/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bounda-dev/bounda/ci.yml?branch=main&style=flat&label=CI" alt="CI status" /></a>
  <a href="https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main"><img src="https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain" alt="Mutation score" /></a>
  <img src="https://img.shields.io/node/v/@bounda-dev/core?style=flat&label=node&color=b07114" alt="Node version" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-b07114?style=flat" alt="License" /></a>
</p>

Your tables keep the last write. Bounda keeps every change, so any view can be rebuilt from it
and any past state explained. Commands, events and projections are plain TypeScript modules,
every type is inferred from them, and it all runs on one database with no broker, or on one
Cloudflare Durable Object per tenant.

```bash
npm create bounda@latest my-app
```

[bounda.dev](https://bounda.dev) ·
**[Documentation](https://docs.bounda.dev)** ·
[Getting started](https://docs.bounda.dev/getting-started/) ·
[Core concepts](https://docs.bounda.dev/getting-started/core-concepts/) ·
[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/bounda-dev/bounda-cloudflare-template)

## What it looks like

A command decides; the event it returns becomes the state. The file's place and name are the
declaration, and `bounda generate` writes the types next to it:

```ts
// app/domain/order/commands/place-order.ts
import type { Command } from "./+types/place-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), customerId: z.string().min(1), total: z.number().positive() });

export const rejections = ({ command }: Command.RejectionsArgs) => ({
  AlreadyPlaced: `Order ${command.aggregateId} was already placed`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (state.status !== undefined) return reject("AlreadyPlaced");
  return [events.orderPlaced({ customerId: command.payload.customerId, total: command.payload.total })];
};
```

`command.payload` is typed from the schema, `state` from the order's events, `events` only offers
this aggregate's events and `reject` only the codes above. A projection turns `OrderPlaced` into a
row a query reads; [the getting started guide](https://docs.bounda.dev/getting-started/) builds
the whole slice in fifteen minutes.

## Why Bounda

- **Types are inferred.** A file's place and name are its declaration, and `bounda generate`
  infers every type from them: no command bus, repository or registry to keep in sync. Change a
  field and the compiler points at every place that breaks.
- **Read models rebuild.** A wrong dashboard is a fixed projection and `bounda rebuild`, not a
  migration script. The events are never touched.
- **Workflows have a home.** A workflow of several steps is a process next to its aggregate, with
  its own state and deadlines, not a state machine buried in a handler. Policies react to events,
  and retries, dead letters and upcasters come with the runtime.
- **Nothing else to run.** Events, read models and the work still pending share one database:
  PostgreSQL, SQLite or libSQL. Start there; when a read model outgrows it, it gets a database of
  its own. On Cloudflare, the database is a Durable Object per tenant.

React Router has its own integration, and the runtime reports OpenTelemetry spans and metrics.
[How Bounda runs](https://docs.bounda.dev/concepts/how-it-runs/) says how far one store goes, and
[what is not there yet](https://docs.bounda.dev/reference/limitations/) is one honest list.

## Status

0.x. Until 1.0 the API can still change between minor versions (0.1 to 0.2), and every change
that breaks something is called out in the changelog of the package it touches.

## Packages

| Package | Purpose |
|---|---|
| [`@bounda-dev/core`](packages/core) | Runtime and public API, with the docs as Markdown for your agent |
| [`@bounda-dev/cli`](packages/cli) | `bounda` CLI: reads the layout, writes the registry and the types |
| [`@bounda-dev/sqlite`](packages/sqlite) | SQLite and libSQL storage |
| [`@bounda-dev/postgresql`](packages/postgresql) | PostgreSQL storage |
| [`@bounda-dev/cloudflare`](packages/cloudflare) | A Durable Object per tenant on Cloudflare |
| [`@bounda-dev/react-router`](packages/react-router) | React Router integration and its Vite plugin |
| [`create-bounda`](packages/create-bounda) | Project scaffolder |

Each package README carries its own mutation score; the badge above is the whole repository.
`@bounda-dev/cloudflare` has none: its tests run inside workerd, where Stryker cannot mutate.

Two runnable examples live here: [`examples/storefront`](examples/storefront), on Node and SQLite,
and [`examples/onboarding`](examples/onboarding), on React Router.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) says how to set the
repository up, what a pull request needs and how to report a security problem.

## License

Apache 2.0. See [LICENSE](LICENSE).
