# Bounda

Event sourcing and CQRS for TypeScript without the ceremony.

Bounda gives you aggregates, commands, events, policies, processes and read models through file
conventions and inferred types. Your business logic lives in small modules that export a handful
of functions. The runtime does the wiring and runs on a single database.

```bash
npm create bounda my-app
```

Documentation: [docs.bounda.dev](https://docs.bounda.dev).

## Status

Alpha. Every version on npm is a prerelease, so a plain install gets one; the API can change
between alphas without a deprecation cycle. Each package has its own changelog.

## Packages

| Package | Purpose |
|---|---|
| [`@bounda-dev/core`](packages/core) | Runtime and public API |
| [`@bounda-dev/cli`](packages/cli) | `bounda` CLI: reads the layout, writes the registry and the types |
| [`@bounda-dev/adapter-sqlite`](packages/adapter-sqlite) | SQLite and libSQL storage |
| [`@bounda-dev/adapter-postgresql`](packages/adapter-postgresql) | PostgreSQL storage |
| [`@bounda-dev/react-router`](packages/react-router) | React Router integration and its Vite plugin |
| [`create-bounda`](packages/create-bounda) | Project scaffolder |

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
