# @bounda-dev/react-router

## 0.1.0-alpha.5

### Patch Changes

- 9be9de3: Document `npm create bounda@latest`. Without the tag, npx can reuse a `create-bounda` it cached
  earlier, and that older scaffolder pins the Bounda packages to the version it shipped with.
- Updated dependencies [43f0f96]
- Updated dependencies [01642b8]
- Updated dependencies [d8c06fa]
- Updated dependencies [02e45fd]
- Updated dependencies [789ac78]
- Updated dependencies [78f9b01]
- Updated dependencies [138ac4a]
  - @bounda-dev/core@0.1.0-alpha.5
  - @bounda-dev/cli@0.1.0-alpha.5

## 0.1.0-alpha.4

### Patch Changes

- 881e03d: Add the mutation score badge to each package's README, linked to its report on the Stryker
  dashboard.
- Updated dependencies [881e03d]
  - @bounda-dev/core@0.1.0-alpha.4
  - @bounda-dev/cli@0.1.0-alpha.4

## 0.1.0-alpha.3

### Patch Changes

- 9e26090: Document installing without a dist-tag. While every published version is a prerelease, changesets
  publishes to `latest`, so `npm create bounda@alpha` resolved to an older alpha than a plain
  `npm create bounda`.
- Updated dependencies [9e26090]
  - @bounda-dev/core@0.1.0-alpha.3
  - @bounda-dev/cli@0.1.0-alpha.3

## 0.1.0-alpha.2

### Patch Changes

- 3e75b91: Keep the package out of Vite's server externals so the `bounda()` plugin serves
  `@bounda-dev/react-router/app` when the package is installed from a registry. Vite matches
  `noExternal` against the package, not the subpath, so a pattern for the subpath alone left the
  real module to be loaded by Node, and every request failed with the "served by the bounda() Vite
  plugin" error. A workspace link is never externalised, which is why the examples in this
  repository worked.
- @bounda-dev/cli@0.1.0-alpha.2
  - @bounda-dev/core@0.1.0-alpha.2

## 0.1.0-alpha.1

### Minor Changes

- 2f9d007: First alpha.
  
  Bounda runs an event-sourced app from the files you write: aggregates, commands, events,
  policies, processes and read models under `app/domain` and `app/read`, wired by a generator that
  also writes every argument type. One database holds the events, the read models, the schedule and
  the dead letters.
  
  - `@bounda-dev/core`: the runtime. Commands append with optimistic concurrency, projections and
    policies run through a dispatcher with checkpoints and at-least-once delivery, processes are
    internal aggregates with time-outs, and queries compose. `boot()` for Node, `createTestApp()`
    for tests, an in-memory adapter and the ports to write your own.
  - `@bounda-dev/cli`: `bounda generate` reads the layout by file names alone and writes the
    registry, the types and a `+types` module next to every file. State is inferred from the `apply`
    functions when an aggregate has no `state.ts`.
  - `@bounda-dev/adapter-sqlite` and `@bounda-dev/adapter-postgresql`: storage on libSQL or
    PostgreSQL, safe for several processes on one database.
  - `@bounda-dev/react-router`: a Vite plugin and a middleware that boot the app once and hand it to
    every loader and action, reading its own writes by default.
  - `create-bounda`: `npm create bounda@alpha`, with a Node or a React Router project.

### Patch Changes

- Updated dependencies [2f9d007]
  - @bounda-dev/core@0.1.0-alpha.1
  - @bounda-dev/cli@0.1.0-alpha.1
