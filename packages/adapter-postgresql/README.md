# @bounda-dev/adapter-postgresql

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

Published under the `alpha` tag. The API can change between alphas without a deprecation cycle.

Docs: [docs.bounda.dev/adapters/postgresql](https://docs.bounda.dev/adapters/postgresql/). Source
and issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
