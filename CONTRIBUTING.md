# Contributing to Bounda

Thanks for taking the time. Bug reports, documentation fixes and pull requests are all welcome.

- **A bug**: open an issue with the smallest project that shows it (a failing test against
  `createTestApp` is ideal), the versions of `@bounda-dev/*` and Node, and the adapter.
- **A change to the API or a new feature**: open an issue first and describe the problem before
  the solution. Bounda keeps a small API on purpose, and agreeing on the shape first saves you a
  rewrite.
- **A security problem**: do not open a public issue. Report it privately from the repository's
  **Security** tab ("Report a vulnerability").

## Setting up

You need Node 22.18 or newer and pnpm 12. Docker is optional: the PostgreSQL tests start a
container and skip themselves when Docker is not running.

```bash
pnpm install
pnpm check
```

`pnpm check` is what CI runs: lint, build, generate the examples' types, typecheck and every test.
The packages and examples type-check against the `dist` of their workspace dependencies, so after
changing a package, `pnpm build` before you typecheck anything that uses it.

| Path | What it holds |
| --- | --- |
| `packages/` | The published packages: `core`, `cli`, the adapters, `react-router` and `create-bounda` |
| `examples/` | `storefront` (Node, SQLite) and `onboarding` (React Router), checked by CI |
| `docs/` | The documentation site, [docs.bounda.dev](https://docs.bounda.dev), built with Starlight |
| `skills/bounda` | The skill that points coding agents at the docs |

Useful commands:

```bash
pnpm --filter @bounda-dev/core test          # one package
pnpm test:types                              # the type-level tests
pnpm --filter @bounda-dev/core test:mutation  # mutation testing with Stryker
pnpm docs:dev                                # the docs site on localhost
```

## What a pull request needs

- **`pnpm check` passes.** The pre-commit hook formats staged files with Biome.
- **Tests for the behaviour you changed**, next to the code (`*.test.ts`), through the public
  behaviour rather than mocks of internals. Adapters test against real databases.
- **Inferred types do not regress.** A change to the generator or to public types adds or updates
  a case in `packages/core/test-types/`. After changing what `bounda generate` writes, regenerate
  the golden fixtures with
  `UPDATE_GOLDEN=1 pnpm --filter @bounda-dev/cli exec vitest run src/generate`.
- **The docs change with the code.** A change to the API, the configuration, the CLI or the file
  conventions updates the pages under `docs/src/content/docs/` in the same pull request.
- **A changeset** when a published package changes: `pnpm changeset`. Until 1.0 a change that
  breaks something is `minor`, anything else `patch`.
- **Mutation testing** runs in CI for the packages you touched, with the score in the job summary.
  Run it locally on that package before you open the pull request; it rewrites the sources while
  it runs, so leave the package alone until it finishes.

Branches are named `feat/`, `fix/`, `docs/`, `refactor/` or `chore/`, and commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/) with the package as scope:
`fix(postgresql): …`.

## Code style

Functional over object-oriented, immutable by default, no `any`. Every exported function has
`XxxArgs` and `XxxFunction` interfaces. Anything exported from a package's entry point is public
API and gets JSDoc that states its contract; other code gets a comment only for what its names and
types cannot say.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), like the rest of the project.
