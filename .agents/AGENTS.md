# Bounda — guide for coding agents

## What this is

Bounda is an event sourcing and CQRS framework for TypeScript. Users write small modules that export functions (`payload`, `handler`, `apply`, `project`) under `app/domain/<aggregate>/` and `app/read/<read-model>/`; the runtime wires them and runs on a single database. Six packages are published to npm under `@bounda-dev/*` (plus `create-bounda`): `core`, `cli`, `adapter-sqlite`, `adapter-postgresql`, `react-router`, `create-bounda`.

## Toolchain

pnpm 12 (workspace catalog, `catalogMode: strict`), TypeScript 7, Biome (lint and format), tsdown (library build, runs publint and attw), Vitest 5, Stryker (mutation testing), Changesets (release), lefthook (pre-commit), Astro Starlight (docs). Node 22.12 or newer.

## Commands (root)

| Command | What it does |
|---|---|
| `pnpm check` | lint, build, typecheck, test — run before every commit (build first: packages type-check against the `dist` of their workspace dependencies) |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc -p` in every package |
| `pnpm build` | tsdown in every package |
| `pnpm test` / `pnpm test:types` | Vitest / Vitest typecheck-only |
| `pnpm changeset` | add a changeset (required when a published package changes) |
| `pnpm docs:dev` / `pnpm docs:build` | Starlight site |
| `pnpm --filter @bounda-dev/core test` | one package |
| `pnpm --filter @bounda-dev/core test:mutation` | Stryker on `kernel/` (slow; CI runs it on `main` only) |

## How to work

- Delegate wide read-only exploration to sub-agents; do coherent refactors yourself so the whole import graph stays in one head.
- `/lead` is optional, for genuinely multi-phase work. One review per logical change, not per phase. Typecheck and tests gate every change.
- Prefer the smallest change that solves the problem. Scope discipline beats "fix everything you see"; note unrelated findings instead of fixing them inline.
- Use Context7 for library and API documentation before guessing.
- Think about what else a change touches: docs pages, the public skill in `skills/bounda`, `create-bounda` templates, examples.

## Code style

- Functional over object-oriented. Immutability by default; `readonly` on argument properties.
- Interface-first: define `XxxArgs` and `XxxFunction` interfaces, then `export const xxx: XxxFunction = (...) => ...`. Exception: code implementing a third-party or platform interface uses that interface directly.
- Files kebab-case; React components PascalCase; types PascalCase. Prefer interfaces over type aliases unless a union or mapped type is needed.
- No `any`. No `// biome-ignore`. Modern TS and JS only.
- No comments that explain implementation; names do that. **JSDoc is required on every public export** of a package's `exports` surface.
- Keep files small. Adapter provider modules may exceed the norm when splitting would fragment one cohesive unit.
- Keep every package `index.ts` thin: what is exported there is public API.

## Types are the product

User-facing inference must never regress. `packages/core/test-types/` holds `expectTypeOf` assertions for every handler argument and return type; it runs in CI via `pnpm test:types`. Any change to typegen or public types adds or updates a case there.

## Testing

- Co-located `*.test.ts`. Behavior tests over implementation-coupled mocks.
- Adapters test against real databases (testcontainers for PostgreSQL, file or memory for SQLite). The PostgreSQL suite starts a `postgres:17` container and skips itself when Docker is not running, so start Docker before `pnpm check` to run it.
- Coverage must not decrease. Mutation testing with Stryker validates test quality.
- A new package goes into `pnpm-workspace.yaml`, the root `tsconfig.json` references, and the CI workflow.

## Publishing

- Every published package declares `license`, `repository` (with `directory`), `files: ["dist"]`, `sideEffects`, `publishConfig.access: public`, and an `exports` map with `types` first. ESM only.
- Internal dependencies use `workspace:*`. Third-party versions come from the pnpm catalog; never inline a version.
- Release is automated: Changesets opens a version PR, merging it publishes via npm trusted publishing (OIDC). No tokens in the repo.

## Docs

A user-facing change (API, config, CLI, conventions) updates `docs/` in the same PR, and `skills/bounda` if the convention changed.

## Git

- Branches: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`. Never commit to `main` directly.
- `pnpm check` green before committing. Conventional commit subjects.
- Commits and PRs are authored solely by the repository owner. No `Co-Authored-By` or agent attribution footers.
