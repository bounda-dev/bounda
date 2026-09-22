# Bounda

Event sourcing and CQRS for TypeScript without the ceremony.

Bounda gives you aggregates, commands, events, policies, processes and read models through file
conventions and inferred types. Your business logic lives in small modules that export a handful
of functions. The runtime does the wiring and runs on a single database.

```bash
npm create bounda@latest my-app
```

Documentation: [docs.bounda.dev](https://docs.bounda.dev).

## Status

Alpha. Every version on npm is a prerelease, so a plain install gets one; the API can change
between alphas without a deprecation cycle. Each package has its own changelog.

## In production

Roles for web and worker processes, any number of instances on PostgreSQL, a dispatcher woken by
`NOTIFY`, OpenTelemetry spans and metrics, `bounda rebuild` for a read model that went wrong,
`bounda dead-letters` for a policy that died, and upcasts for events whose payload changed. What
is not there yet, and why, is one list in the
[deployment guide](https://docs.bounda.dev/guides/deployment/#what-is-not-there-yet).

## Packages

| Package | Purpose | Mutation score |
|---|---|---|
| [`@bounda-dev/core`](packages/core) | Runtime and public API | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcore)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=core) |
| [`@bounda-dev/cli`](packages/cli) | `bounda` CLI: reads the layout, writes the registry and the types | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcli)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=cli) |
| [`@bounda-dev/adapter-sqlite`](packages/adapter-sqlite) | SQLite and libSQL storage | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dadapter-sqlite)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=adapter-sqlite) |
| [`@bounda-dev/adapter-postgresql`](packages/adapter-postgresql) | PostgreSQL storage | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dadapter-postgresql)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=adapter-postgresql) |
| [`@bounda-dev/react-router`](packages/react-router) | React Router integration and its Vite plugin | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dreact-router)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=react-router) |
| [`create-bounda`](packages/create-bounda) | Project scaffolder | [![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcreate-bounda)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=create-bounda) |

Two examples live in this repository: [`examples/storefront`](examples/storefront) on Node and
SQLite, and [`examples/onboarding`](examples/onboarding) on React Router and PostgreSQL or SQLite.

## Development

Requires Node 22.18 or newer and pnpm 12.

```bash
pnpm install
pnpm check
```

`pnpm check` runs lint, build, generate, typecheck and tests across every package and example.
`pnpm --filter <package> test:mutation` runs Stryker on one package; CI runs it for the packages a
pull request touches.

## License

Apache 2.0. See [LICENSE](LICENSE).
