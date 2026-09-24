<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.bounda.dev/wordmark-dark.svg" />
    <img src="https://docs.bounda.dev/wordmark-light.svg" alt="Bounda" width="160" />
  </picture>
</p>

# @bounda-dev/adapter-sqlite

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dadapter-sqlite)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=adapter-sqlite)

SQLite storage for [Bounda](https://docs.bounda.dev), through libSQL: a local file, memory, or a
libSQL server such as Turso.

```bash
npm install @bounda-dev/core @bounda-dev/adapter-sqlite
```

```ts
// bounda.config.ts
import { sqlite } from "@bounda-dev/adapter-sqlite";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: sqlite({ path: "./data/app.db" }),
});
```

`sqlite({ memory: true })` keeps everything in memory; `sqlite({ url, authToken })` points at a
libSQL server. A second argument prefixes the tables it creates (`bounda_` by default).

The adapter holds the event store, the checkpoints, the inbox, the dead letters, the scheduler and
the read-model tables. Appends run in `BEGIN IMMEDIATE` transactions and claims are single
statements with `RETURNING`, so several workers on the same file stay correct. Storage and read
models opened from the same adapter share one connection.

## Status

0.x. Until 1.0 the API can still change between minor versions, and every change that breaks
something is called out in the changelog.

Docs: [docs.bounda.dev/adapters/sqlite](https://docs.bounda.dev/adapters/sqlite/). Source and
issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
