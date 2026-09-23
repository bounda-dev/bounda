# Bounda — guide for coding agents

## What this is

Bounda is an event sourcing and CQRS framework for TypeScript. Users write small modules that export functions (`payload`, `handler`, `apply`, `project`) under `app/domain/<aggregate>/` and `app/read/<read-model>/`; the runtime wires them and runs on a single database. Seven packages are published to npm under `@bounda-dev/*` (plus `create-bounda`): `core`, `cli`, `adapter-sqlite`, `adapter-postgresql`, `adapter-cloudflare`, `react-router`, `create-bounda`.

## Toolchain

pnpm 12 (workspace catalog, `catalogMode: strict`), TypeScript 7, Biome (lint and format), tsdown (library build, runs publint and attw), Vitest 5, Stryker (mutation testing), Changesets (release), lefthook (pre-commit), Astro Starlight (docs). Node 22.18 or newer.

## Commands (root)

| Command | What it does |
|---|---|
| `pnpm check` | lint, build, generate, typecheck, test — run before every commit (build first: packages and examples type-check against the `dist` of their workspace dependencies; `generate` runs `bounda generate` in every example) |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc -p` in every package |
| `pnpm build` | tsdown in every package |
| `pnpm generate` | `bounda generate` in every example (`examples/*`), needs `build` first |
| `pnpm test` / `pnpm test:types` | Vitest / Vitest typecheck-only |
| `pnpm changeset` | add a changeset (required when a published package changes) |
| `pnpm docs:dev` / `pnpm docs:build` | Starlight site |
| `pnpm --filter @bounda-dev/core test` | one package |
| `pnpm --filter <package> test:mutation` | Stryker with the vitest runner (`core`, `adapter-sqlite`, `adapter-postgresql`, `cli`, `react-router`, `create-bounda`). Run it locally on the package you touched before opening a PR; CI runs it too, one job per package changed by the PR (every package when the toolchain changes), with the score in the job summary and the HTML report as an artifact. Build `core` first: the other packages test against its `dist`. Stryker rewrites the package's sources in place while it runs (`inPlace`): never run it in the background, never edit or test the package meanwhile, and run neither `pnpm check` nor `git add` until it has finished, because both read the mutated files (`git status` shows the whole package modified while it runs). If a run is interrupted, `git checkout -- packages/<package>` restores the sources and the two config files it patches; `.stryker-tmp/backup-*` holds the same |
| `UPDATE_GOLDEN=1 pnpm --filter @bounda-dev/cli exec vitest run src/generate` | regenerate the `order-app` and `order-app-inferred` fixtures under `packages/core/test-types/fixtures` after changing the generator's output |

## How to work

- Delegate wide read-only exploration to sub-agents; do coherent refactors yourself so the whole import graph stays in one head.
- `/lead` is optional, for genuinely multi-phase work. One review per logical change, not per phase. Typecheck and tests gate every change.
- Prefer the smallest change that solves the problem. Scope discipline beats "fix everything you see"; note unrelated findings instead of fixing them inline.
- Use Context7 for library and API documentation before guessing.
- Think about what else a change touches: docs pages, the public skill in `skills/bounda`, `create-bounda` templates, examples.
- Two examples: `examples/storefront` (plain Node, SQLite) and `examples/onboarding` (React Router 8 through the `bounda()` Vite plugin in `@bounda-dev/react-router/vite`, PostgreSQL or SQLite). Request-level concerns such as read-your-writes belong to the host package (`@bounda-dev/react-router`), never to `core` as a default; `core` only offers the primitives (`catchUpReadModels`, `readYourWrites`).

## Code style

- Functional over object-oriented. Immutability by default; `readonly` on argument properties.
- Interface-first: define `XxxArgs` and `XxxFunction` interfaces, then `export const xxx: XxxFunction = (...) => ...`. Exception: code implementing a third-party or platform interface uses that interface directly.
- Files kebab-case; React components PascalCase; types PascalCase. Prefer interfaces over type aliases unless a union or mapped type is needed.
- No `any`. No `// biome-ignore`. Modern TS and JS only.
- No comments that explain implementation; names do that. **JSDoc is required on every public export** of a package's `exports` surface.
- Keep files small. Adapter provider modules may exceed the norm when splitting would fragment one cohesive unit.
- Keep every package `index.ts` thin: what is exported there is public API.

## Where adapter code lives

The rule, written down because it is not obvious: **code shared by two or more adapters lives in `core/adapter/*`; code only one adapter uses stays in that adapter's package.** `core/adapter/sql` holds the dialects, the query builder and the read-model schema that SQLite and PostgreSQL share. `core/adapter/sqlite` holds the SQLite stores, schema and read models, shared by libSQL (`adapter-sqlite`) and the Durable Object (`adapter-cloudflare`); each of those packages only brings its connection through `createSqliteAdapter`. The PostgreSQL stores stay in `adapter-postgresql` because nothing else speaks that SQL. It costs an app nothing: each is a subpath without side effects, loaded only when imported. Revisit if a third SQL engine appears or if the size of `core` starts to matter; the alternative is a `sqlite-storage` package both adapters depend on.

## The generator

`packages/cli` holds `bounda generate`: it reads `app/domain` and `app/read` by file and directory names only (no module is imported or parsed), and writes `.bounda/registry.ts`, `.bounda/register.d.ts` (registers the registry type with `@bounda-dev/core/register`, so `boot()` needs no type argument), `.bounda/types.ts` and one `+types/<name>.ts` next to every module. Its output has a canonical layout that Biome does not touch (`**/+types/**` and `.bounda/` are excluded); the fixtures under `packages/core/test-types/fixtures` are literally that output and the golden tests compare them byte for byte. State for aggregates without `state.ts` is inferred with the TypeScript 7 API in `packages/cli/src/generate/state/infer.ts`, the only module that touches that API. When the generator's output changes, regenerate the fixtures and check `pnpm test:types` still passes.

## create-bounda

`packages/create-bounda/template/` is a real project: `base/` (the domain, the read model, the test), one overlay per database (`sqlite/`, `postgresql/`) and one per framework (`node/`: script and manifest; `react-router/`: Vite config, routes, manifest), applied in that order. `*.tpl` files are rendered (`{{name}}`, versions), `_gitignore` becomes `.gitignore`, everything else is copied. Its end-to-end test scaffolds a project, links the workspace packages into it and runs `bounda generate`, `tsc` and `vitest` there, so a template that does not compile fails CI. Tool versions written into generated projects live in `src/versions.ts` and a test keeps them equal to the catalog. The `cloudflare` framework is one overlay with its own storage (no database layer). `OFFER_CLOUDFLARE` in `src/options.ts` gates it in the prompt; it is `true` now that `@bounda-dev/adapter-cloudflare` is on npm, and the same kind of switch is how to add a framework whose package is not published yet. The Cloudflare overlay follows Cloudflare's conventions: tests inside workerd with `@cloudflare/vitest-plugin` (so Vitest 4.1: its version is that of `@vitest/runner`, a dev dependency of `create-bounda` from the `cloudflare` catalog, because the package cannot depend on two `vitest`), `wrangler types` instead of `@cloudflare/workers-types`, and no `prepare` script (`npm install --package-lock-only` runs it without `node_modules`), so `create-bounda` runs its `generate` (`bounda generate && wrangler types`) after the install; its end-to-end case links Vitest and the plugin from `adapter-cloudflare`.

## Template copies

The Cloudflare project exists in two more places, both generated from the published `create-bounda`: `bounda-dev/bounda-cloudflare-template`, with the Deploy to Cloudflare button, and `bounda-event-sourcing-template/` in `cloudflare/templates`. Never edit their app code by hand; change the overlay here and regenerate. What each copy adds lives in `packages/create-bounda/distribution/<copy>/` (`layer.json`: its `package.json` extras, `catalog:` specifiers resolved against the workspace catalog, and how it pins versions; `files/`: files over the generated ones; `root/`: files next to the template in a repository of templates). `pnpm templates:sync <bounda-cloudflare-template|cloudflare-templates> --into <clone>` rewrites a clone: it scaffolds with the version on npm (waiting until the registry serves it), lays the layer, installs to write the lockfile and `worker-configuration.d.ts`, and for `cloudflare/templates` aligns every version with the other templates there (its `.syncpackrc.json` pins first), takes the compatibility date its linter requires, and runs its syncpack, Prettier and `templates.json` hash. `--scaffolder workspace` tries an unreleased overlay. After a release that changes the overlay, sync both and open a pull request in each repository; never push to them from CI, since whoever presses the button deploys that repository. `.github/workflows/templates.yml` runs `pnpm templates:check` every week and fails when `bounda-cloudflare-template` drifts, comparing everything but the lockfile and the binding types, which only have to exist.

## Types are the product

User-facing inference must never regress. `packages/core/test-types/` holds `expectTypeOf` assertions for every handler argument and return type; it runs in CI via `pnpm test:types`. Any change to typegen or public types adds or updates a case there.

## Testing

- Co-located `*.test.ts`. Behavior tests over implementation-coupled mocks.
- Adapters test against real databases (testcontainers for PostgreSQL, file or memory for SQLite). The SQLite SQL (stores, schema, read models) lives in `core/src/adapter/sqlite` behind `SqlDatabase` and `createSqliteAdapter`, and is tested there on `node:sqlite`; `adapter-sqlite` only brings the libSQL connection. A change to that SQL is a change to `core`. The PostgreSQL suite starts a `postgres:17` container and skips itself when Docker is not running, so start Docker before `pnpm check` to run it.
- Coverage must not decrease. Mutation testing with Stryker validates test quality (`patches/` carries a fix for `@stryker-mutator/vitest-runner` with Vitest 5: it joined suite and test names with a space where Vitest 5 uses ` > `, so no test matched and every mutant survived).
- A new package goes into `pnpm-workspace.yaml`, the root `tsconfig.json` references, and the CI workflow.
- `adapter-cloudflare` tests run inside workerd through `@cloudflare/vitest-plugin`, which needs Vitest 4.1: the package takes it from the named catalog `cloudflare`, the root Vitest run excludes it, and `pnpm test` runs it afterwards. It has no mutation run, because Stryker never activates a mutant inside workerd; keep that package to glue (connection, Durable Object class, client) and put logic worth measuring in `core`. Pick Cloudflare tooling versions older than a day: pnpm's release-age guard would otherwise add them to `minimumReleaseAgeExclude`, and that list must not grow to fit a fresh release. The storage contracts run there too (`test/storage-contracts.test.ts`) on an app-less `Bare` object: a Durable Object's storage only answers calls made from the object's own context, so `test/inside-object.ts` wraps the adapter and runs every method call through `runInDurableObject`. A test that waits on a signal raised inside the object continues in the object's context and can no longer call into it, so the contract cases that make one call wait for another are skipped there with `concurrent: false`, and each has an in-object equivalent in `test/read-model-transaction.test.ts`.

## Publishing

- Every published package declares `license`, `repository` (with `directory`), `files: ["dist"]`, `sideEffects`, `publishConfig.access: public`, and an `exports` map with `types` first. ESM only.
- Internal dependencies use `workspace:*`. Third-party versions come from the pnpm catalog; never inline a version.
- Release is automated: Changesets opens a version PR, merging it publishes via npm trusted publishing (OIDC). No tokens in the repo.
- **The version PR has no CI.** `changesets/action` opens it with `GITHUB_TOKEN`, and pushes made with that token do not trigger workflows, so waiting for its checks waits forever. Validate it locally — `git fetch origin changeset-release/main && git checkout FETCH_HEAD && pnpm check` — and merge with `gh pr merge <n> --squash --admin`, which the branch protection expects (administrators are deliberately not included for this reason).
- Leaving that PR open accumulates changesets: the next version rises as they land, and nothing publishes until it is merged.
- After a release that changes the Cloudflare overlay, regenerate the template copies (see Template copies).
- **`npm` refuses to run inside the repo**: `devEngines.packageManager` has `onFail: "error"`, which is what stops anyone creating a `package-lock.json` next to `pnpm-lock.yaml`. It also stops the harmless registry commands, so run those from elsewhere: `cd ~ && npm dist-tag ls @bounda-dev/core`. Do not soften the field to keep them working.

## Docs

A user-facing change (API, config, CLI, conventions) updates `docs/` in the same PR, and `skills/bounda` if the convention changed.

The documentation is this repository's `docs/` (Starlight, served at `docs.bounda.dev` from GitHub Pages). The landing page is **not** here: it lives in `bounda-dev/bounda-website`, deployed to `bounda.dev` as a Cloudflare Worker serving static assets. The two sites share a palette — `src/styles/tokens.css` there, `docs/src/styles/bounda.css` here — so a change to colours or typography belongs in both. The landing answers "what is this and why"; anything about *how* belongs in `docs/`.

## Git

- Branches: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`. Never commit to `main` directly.
- `pnpm check` green before committing. Conventional commit subjects.
- Commits and PRs are authored solely by the repository owner. No `Co-Authored-By` or agent attribution footers.
- **Stacked pull requests**: merging the lower one with `--delete-branch` makes GitHub close the upper one, and it cannot be reopened after a rebase. Merge the lower one without deleting its branch, rebase the upper one onto `main` with `git rebase --onto origin/main <old base>`, push it with `--force-with-lease`, retarget it with `gh pr edit <n> --base main`, and delete the lower branch last.
