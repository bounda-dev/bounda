# Bounda — guide for coding agents

## What this is

Bounda is an event sourcing and CQRS framework for TypeScript. Users write small modules that export functions (`payload`, `handler`, `apply`, `project`) under `app/domain/<aggregate>/` and `app/read/<read-model>/`; the runtime wires them and runs on a single database. Seven packages are published to npm under `@bounda-dev/*` (plus `create-bounda`): `core`, `cli`, `sqlite`, `postgresql`, `cloudflare`, `react-router`, `create-bounda`.

## Toolchain

pnpm 12 (workspace catalog, `catalogMode: strict`), TypeScript 7, Biome (lint and format), tsdown (library build, runs publint and attw), Vitest 5, Stryker (mutation testing), Changesets (release), lefthook (pre-commit), Astro Starlight (docs). Node 22.18 or newer.

## Commands (root)

| Command | What it does |
|---|---|
| `pnpm check` | lint, build, generate, typecheck, test — run before every commit (build first: packages and examples type-check against the `dist` of their workspace dependencies; `generate` runs `bounda generate` in every example) |
| `pnpm lint` / `pnpm format` | Biome check / write |
| `pnpm typecheck` | `tsc -p` in every package and example; `astro check` in `docs`, on TypeScript 6 from the `docs` catalog because it does not accept 7 |
| `pnpm build` | tsdown in every package |
| `pnpm generate` | `bounda generate` in every example (`examples/*`), needs `build` first |
| `pnpm test` / `pnpm test:types` | Vitest / Vitest typecheck-only |
| `pnpm changeset` | add a changeset (required when a published package changes) |
| `pnpm docs:dev` / `pnpm docs:build` | Starlight site |
| `pnpm --filter @bounda-dev/core test` | one package |
| `pnpm --filter <package> test:mutation` | Stryker with the vitest runner (`core`, `sqlite`, `postgresql`, `cli`, `react-router`, `create-bounda`, `cloudflare`). Run it locally on the package you touched before opening a PR; CI runs it too, one job per package changed by the PR (every package when the toolchain changes), with the score in the job summary and the HTML report as an artifact. Build `core` first: the other packages test against its `dist`. Stryker rewrites the package's sources in place while it runs (`inPlace`): never run it in the background, never edit or test the package meanwhile, and run neither `pnpm check` nor `git add` until it has finished, because both read the mutated files (`git status` shows the whole package modified while it runs). If a run is interrupted, `git checkout -- packages/<package>` restores the sources and the two config files it patches; `.stryker-tmp/backup-*` holds the same |
| `UPDATE_GOLDEN=1 pnpm --filter @bounda-dev/cli exec vitest run src/generate` | regenerate the `order-app` and `order-app-inferred` fixtures under `packages/core/test-types/fixtures` after changing the generator's output |

## How to work

- Delegate wide read-only exploration to sub-agents; do coherent refactors yourself so the whole import graph stays in one head.
- `/lead` is optional, for genuinely multi-phase work. One review per logical change, not per phase. Typecheck and tests gate every change.
- Run `/code-review` on the branch before it goes up for review, unprompted, alongside `pnpm check` rather than after CI; fix what it confirms, then push (when and how: the `git` skill, "Pre-push review").
- Prefer the smallest change that solves the problem. Scope discipline beats "fix everything you see"; note unrelated findings instead of fixing them inline.
- Use Context7 for library and API documentation before guessing.
- Think about what else a change touches: docs pages, the public skill in `skills/bounda`, `create-bounda` templates, examples.
- Two examples: `examples/storefront` (plain Node, SQLite) and `examples/onboarding` (React Router 8 through the `bounda()` Vite plugin in `@bounda-dev/react-router/vite`, PostgreSQL or SQLite). Request-level concerns such as read-your-writes belong to the host package (`@bounda-dev/react-router`), never to `core` as a default; `core` only offers the primitives (`catchUpReadModels`, `readYourWrites`).

## Code style

- Functional over object-oriented. Immutability by default; `readonly` on argument properties.
- Interface-first: define `XxxArgs` and `XxxFunction` interfaces, then `export const xxx: XxxFunction = (...) => ...`. Exception: code implementing a third-party or platform interface uses that interface directly.
- Files kebab-case; React components PascalCase; types PascalCase. Prefer interfaces over type aliases unless a union or mapped type is needed.
- No `any`. No `// biome-ignore`. Modern TS and JS only.
- Comments are read on every change and go stale silently; each one must earn its place (see below).
- Keep files small. Adapter provider modules may exceed the norm when splitting would fragment one cohesive unit.
- Keep every package `index.ts` thin: what is exported there is public API.

### Comments and JSDoc

- **Public API** (reachable from a package's `exports` map): JSDoc is required, and it states the contract: what it does, when to use it, what it guarantees, what it throws. Not how it works inside; the reader is a user in their editor. A few lines, rarely more.
- **Everything else** (exported between files, but not from the package): no JSDoc by default. Write a comment only for what names and types cannot say: an invariant that is easy to break, the reason for a non-obvious choice (ordering, locking, crash safety), or the meaning of a value the type leaves open. At most a few lines, on the code it guards.
- Never narrate the algorithm step by step: the code says it, and the tests pin it down. Before removing a behaviour from prose, find the test that pins it; when there is none, add one or keep the comment.
- Never restate a literal or a default in prose ("after 20 writes", "defaults to 1 second"); name the constant or leave it out. The exception is the default of a public option: it is part of the contract a user reads on hover, so its JSDoc says it, naming the constant when one is exported.
- Do not document a member whose name and type already say it (`timeoutMs: number` needs nothing).
- When a change makes a comment longer, check whether it should be shorter instead.

## Where adapter code lives

The rule, written down because it is not obvious: **code shared by two or more adapters lives in `core/adapter/*`; code only one adapter uses stays in that adapter's package.** `core/adapter/sql` holds the dialects, the query builder and the read-model schema that SQLite and PostgreSQL share. `core/adapter/sqlite` holds the SQLite stores, schema and read models, shared by libSQL (`@bounda-dev/sqlite`) and the Durable Object (`@bounda-dev/cloudflare`); each of those packages only brings its connection through `createSqliteAdapter`. The PostgreSQL stores stay in `@bounda-dev/postgresql` because nothing else speaks that SQL. It costs an app nothing: each is a subpath without side effects, loaded only when imported. Revisit if a third SQL engine appears or if the size of `core` starts to matter; the alternative is a `sqlite-storage` package both adapters depend on.

## The generator

`packages/cli` holds `bounda generate`: it reads `app/domain` and `app/read` by file and directory names (no module is imported; the only text read is a regex over the exports of the modules at an aggregate's or a read model's root, which tells an event (`payload`, `begin`, `evolve`) from any other module, of a policy or projection for `on`, and of a port's module for the interface named after it), and writes `.bounda/registry.ts`, `.bounda/register.d.ts` (registers the registry type with `@bounda-dev/core/register`, so `boot()` needs no type argument), `.bounda/types.ts` and one `+types/<name>.ts` next to every module. Its output has a canonical layout that Biome does not touch (`**/+types/**` and `.bounda/` are excluded); the fixtures under `packages/core/test-types/fixtures` are literally that output and the golden tests compare them byte for byte. State for aggregates without `state.ts` is inferred with the TypeScript 7 API in `packages/cli/src/generate/state/infer.ts`, the only module that touches that API. When the generator's output changes, regenerate the fixtures and check `pnpm test:types` still passes.

## create-bounda

`packages/create-bounda/template/` is a real project, in layers applied in order, later ones winning: `base/` (the domain, the read model, the test); the database (`sqlite/`, `postgresql/`, or `durable-object/`, which comes with the `cloudflare` runtime, is never asked for and also brings the Vitest config that runs the tests in workerd, where the object lives); then, without a framework, the runtime's project (`node/`: script and manifest; `cloudflare/`: Worker with a JSON API, page, `wrangler.jsonc`), or, with one, the framework's files every runtime shares (`react-router/`: routes, page, `react-router.config.ts`) and those that tie it to the runtime (`node-react-router/`, `cloudflare-react-router/`: manifest, Vite config, `tsconfig.json`; on Cloudflare also `workers/app.ts`, `wrangler.jsonc` and `app/tenant.ts`). The flags follow the same axes: `--runtime node|cloudflare`, `--framework none|react-router`, `--database sqlite|postgresql` (Node only, so naming one means Node). `*.tpl` files are rendered (`{{name}}`, versions, and `{{<script>Command}}`, a script spelled for the chosen package manager), `_gitignore` becomes `.gitignore`, everything else is copied. Its end-to-end test scaffolds each runtime with and without React Router, links the workspace packages into it and runs `bounda generate`, `tsc` and `vitest` there, and for a framework or a Worker also builds and serves it, so a template that does not compile or run fails CI. Tool versions written into generated projects live in `src/versions.ts` and a test keeps them equal to the catalog. Package managers start through `realExec`, which goes through the shell because on Windows they are `.cmd` shims, and refuses anything but plain words. `OFFER_CLOUDFLARE` in `src/options.ts` gates the `cloudflare` runtime in the prompt; it is `true` now that `@bounda-dev/cloudflare` is on npm, and the same kind of switch is how to add a runtime or framework whose package is not published yet. The Cloudflare layers follow Cloudflare's conventions: tests inside workerd with `@cloudflare/vitest-plugin`, `wrangler types` instead of `@cloudflare/workers-types`, and no `prepare` script (`npm install --package-lock-only` runs it without `node_modules`), so `create-bounda` runs its `generate` after the install.

## Template copies

The Cloudflare project without a framework exists in two more places, both generated from the published `create-bounda`: `bounda-dev/bounda-cloudflare-template`, with the Deploy to Cloudflare button, and `bounda-event-sourcing-template/` in `cloudflare/templates`. Never edit their app code by hand; change the layers here and regenerate. What each copy adds lives in `packages/create-bounda/distribution/<copy>/` (`layer.json`: its `package.json` extras, `catalog:` specifiers resolved against the workspace catalog, and how it pins versions; `files/`: files over the generated ones; `root/`: files next to the template in a repository of templates). `pnpm templates:sync <bounda-cloudflare-template|cloudflare-templates> --into <clone>` rewrites a clone: it scaffolds with the version on npm (waiting until the registry serves it), lays the layer, installs to write the lockfile and `worker-configuration.d.ts`, and for `cloudflare/templates` aligns every version with the other templates there (its `.syncpackrc.json` pins first), takes the compatibility date its linter requires, and at that repository's root runs `pnpm install` (its workspace lockfile lists every template), its `fix:templates` linter (which rewrites `wrangler.jsonc` in its own layout), syncpack, Prettier and the `templates.json` hash, so its pre-push `fix` leaves no diff. `--scaffolder workspace` tries unreleased layers. After a release that changes them, sync both and open a pull request in each repository; never push to them from CI, since whoever presses the button deploys that repository. `.github/workflows/templates.yml` runs `pnpm templates:check` every week and fails when `bounda-cloudflare-template` drifts, comparing everything but the lockfile and the binding types, which only have to exist.

## Types are the product

User-facing inference must never regress. `packages/core/test-types/` holds `expectTypeOf` assertions for every handler argument and return type; it runs in CI via `pnpm test:types`. Any change to typegen or public types adds or updates a case there.

## Testing

- Co-located `*.test.ts`. Behavior tests over implementation-coupled mocks.
- CI also runs the tests of `core`, `sqlite`, `cli`, `react-router` and `create-bounda` on Windows (the `Windows` job), whenever a package changes, because projects run there too. A path that goes into generated code, a report or a comparison is written with `/`: `posix`, Vite's `normalizePath`, or a `relative()` with `\` replaced. Tests that need Linux containers or process groups stay on Linux. `.gitattributes` keeps every text file LF on checkout. A `package.json` script quotes a glob with double quotes: on Windows `cmd.exe` runs it and keeps single quotes as part of the argument, which made `--filter './packages/*'` match nothing; the root's filtered scripts pass `--fail-if-no-match` so that cannot pass silently again.
- Adapters test against real databases (testcontainers for PostgreSQL, file or memory for SQLite). The SQLite SQL (stores, schema, read models) lives in `core/src/adapter/sqlite` behind `SqlDatabase` and `createSqliteAdapter`, and is tested there on `node:sqlite`; `@bounda-dev/sqlite` only brings the libSQL connection. A change to that SQL is a change to `core`. The PostgreSQL suite starts a `postgres:17` container and skips itself when Docker is not running, so start Docker before `pnpm check` to run it.
- Coverage must not decrease. Mutation testing with Stryker validates test quality (`patches/` carries a fix for `@stryker-mutator/vitest-runner` with Vitest 5: it joined suite and test names with a space where Vitest 5 uses ` > `, so no test matched and every mutant survived).
- A new package goes into `pnpm-workspace.yaml`, the root `tsconfig.json` references, and the CI workflow.
- `@bounda-dev/cloudflare` tests run inside workerd through `@cloudflare/vitest-plugin`, as one more project of the root Vitest run, and Stryker's mutants activate there like anywhere else. Pick Cloudflare tooling versions older than a day: pnpm's release-age guard would otherwise add them to `minimumReleaseAgeExclude`, and that list must not grow to fit a fresh release. The storage contracts run there too (`test/storage-contracts.test.ts`) on an app-less `Bare` object: a Durable Object's storage only answers calls made from the object's own context, so `test/inside-object.ts` wraps the adapter and runs every method call through `runInDurableObject`. A test that waits on a signal raised inside the object continues in the object's context and can no longer call into it, so the contract cases that make one call wait for another are skipped there with `concurrent: false`, and each has an in-object equivalent in `test/read-model-transaction.test.ts`.
- `react-router` runs its Cloudflare host in Node, under Vitest and Stryker: `vitest.config.ts` aliases `cloudflare:workers` to `src/cloudflare/test-support.ts`, whose `env` a test fills with a fake namespace. What only `workerd` and `@cloudflare/vite-plugin` show (the `workerd` condition of `./host`, the glob that makes `app/tenant.ts` optional, the pre-bundling of the Worker's environment) has no automated test until the Cloudflare and React Router template exists: when it changes, check it by hand in a project with the workspace packages packed into it, under `vite dev`, `vite build` and `wrangler dev`.

## Publishing

- Every published package declares `license`, `repository` (with `directory`), `files: ["dist"]` (`core` adds `docs`, see Docs), `sideEffects`, `publishConfig.access: public`, and an `exports` map with `types` first. ESM only.
- Internal dependencies use `workspace:*`. Third-party versions come from the pnpm catalog; never inline a version.
- Release is automated: Changesets opens a version PR, merging it publishes via npm trusted publishing (OIDC). No tokens in the repo.
- **The version PR has no CI.** `changesets/action` opens it with `GITHUB_TOKEN`, and pushes made with that token do not trigger workflows, so waiting for its checks waits forever. Validate it locally — `git fetch origin changeset-release/main && git checkout FETCH_HEAD && pnpm check` — and merge with `gh pr merge <n> --squash --admin`, which the branch protection expects (administrators are deliberately not included for this reason).
- Leaving that PR open accumulates changesets: the next version rises as they land, and nothing publishes until it is merged.
- After a release that changes what `--runtime cloudflare` scaffolds without a framework, regenerate the template copies (see Template copies).
- **`npm` refuses to run inside the repo**: `devEngines.packageManager` has `onFail: "error"`, which is what stops anyone creating a `package-lock.json` next to `pnpm-lock.yaml`. It also stops the harmless registry commands, so run those from elsewhere: `cd ~ && npm dist-tag ls @bounda-dev/core`. Do not soften the field to keep them working.

## Docs

A user-facing change (API, config, CLI, conventions) updates `docs/` in the same PR. `skills/bounda` only says what Bounda is and where the docs are, so it changes only if that does.

The docs also ship inside `@bounda-dev/core`: its build (`src/docs/`) packs every page into `packages/core/docs/` as plain Markdown, with links rewritten between the files and a `README.md` index in sidebar order, so an agent reads the docs of the version installed. A page is `.md`, or `.mdx` when it uses Starlight's `Tabs`, `Steps` or `FileTree`, which the pack turns into Markdown; any other component fails the build, as does a link to a page that does not exist or a page outside a sidebar group. The site's `/` forwards to getting started (`docs/src/pages/index.astro`), where the wordmark links too. A new sidebar group goes into `docs/src/sidebar.ts` and into `GROUPS` in `src/docs/pack.ts`, which a test keeps equal; the sidebar also names each page's group on its social card (`docs/src/pages/og/`). Projects from `create-bounda` carry an `AGENTS.md` pointing there, with no `CLAUDE.md`: Claude Code reads `AGENTS.md` itself.

The documentation is this repository's `docs/` (Starlight, served at `docs.bounda.dev` from GitHub Pages). The landing page is **not** here: it lives in `bounda-dev/bounda-website`, deployed to `bounda.dev` as a Cloudflare Worker serving static assets. The two sites share a palette — `src/styles/tokens.css` there, `docs/src/styles/bounda.css` here — so a change to colours or typography belongs in both. The landing answers "what is this and why"; anything about *how* belongs in `docs/`.

## Git

- Branches: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`. Never commit to `main` directly.
- `pnpm check` green before committing. Conventional commit subjects.
- Commits and PRs are authored solely by the repository owner. No `Co-Authored-By` or agent attribution footers.
- **Stacked pull requests**: the repository deletes a head branch when its pull request merges, and GitHub then retargets the pull request stacked on it to the merged one's base, so no retarget or deletion is needed. Note the tip of every branch in the stack first, merge the lowest with `gh pr merge <n> --squash`, then rebase each branch above onto its new base from the old tip it was on (`git rebase --onto origin/main <old tip of the merged branch>` for the first, `--onto <rebased branch> <old tip of the branch below>` for the rest) and push them with `--force-with-lease`. Never close a stacked pull request to reopen it after a rebase: it cannot be reopened.
