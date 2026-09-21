# @bounda-dev/adapter-sqlite

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

## Alpha

Published under the `alpha` tag. The API can change between alphas without a deprecation cycle.

Docs: [docs.bounda.dev/adapters/sqlite](https://docs.bounda.dev/adapters/sqlite/). Source and
issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
