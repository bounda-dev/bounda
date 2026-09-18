# Bounda

Event sourcing and CQRS for TypeScript without the ceremony.

Bounda gives you aggregates, commands, events, policies, processes and read models through file conventions and inferred types. Your business logic lives in small modules that export a handful of functions. The runtime does the wiring and runs on a single database.

## Status

Pre-alpha. Packages under `@bounda-dev/*` are not published yet.

## Packages

| Package | Purpose |
|---|---|
| `@bounda-dev/core` | Runtime and public API |
| `@bounda-dev/cli` | `bounda` CLI: dev server, type generation, ops |
| `@bounda-dev/adapter-sqlite` | SQLite and libSQL storage |
| `@bounda-dev/adapter-postgresql` | PostgreSQL storage |
| `@bounda-dev/react-router` | React Router integration |
| `create-bounda` | Project scaffolder |

## Development

Requires Node 22.12 or newer and pnpm 12.

```bash
pnpm install
pnpm check
```

`pnpm check` runs lint, typecheck, build and tests across all packages.

## License

Apache 2.0. See [LICENSE](LICENSE).
