<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.bounda.dev/wordmark-dark.svg" />
    <img src="https://docs.bounda.dev/wordmark-light.svg" alt="Bounda" width="160" />
  </picture>
</p>

# @bounda-dev/adapter-postgresql

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dadapter-postgresql)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=adapter-postgresql)

PostgreSQL storage for [Bounda](https://docs.bounda.dev), for when one process is not enough.

```bash
npm install @bounda-dev/core @bounda-dev/adapter-postgresql
```

```ts
// bounda.config.ts
import { postgresql } from "@bounda-dev/adapter-postgresql";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: postgresql({ url: process.env.DATABASE_URL }),
});
```

Connection parts work too (`{ host, database, user, port?, password?, ssl? }`), and further
arguments set the schema, the table prefix and the pool size.

Appends take a transaction-scoped advisory lock, so global positions never have gaps for readers;
claims use `FOR UPDATE SKIP LOCKED`, so many web and worker processes can share one database
without stepping on each other.

## Alpha

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev/adapters/postgresql](https://docs.bounda.dev/adapters/postgresql/). Source
and issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
