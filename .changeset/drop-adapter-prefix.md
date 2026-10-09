---
"@bounda-dev/sqlite": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cloudflare": minor
"create-bounda": patch
---

The adapter packages lose their `adapter-` prefix: `@bounda-dev/adapter-sqlite` is
`@bounda-dev/sqlite`, `@bounda-dev/adapter-postgresql` is `@bounda-dev/postgresql` and
`@bounda-dev/adapter-cloudflare` is `@bounda-dev/cloudflare`. What they export does not change;
replace the name in `package.json` and in the imports. Projects from `create-bounda` depend on the
new names.
