---
"@bounda-dev/core": minor
"@bounda-dev/sqlite": minor
"@bounda-dev/postgresql": minor
"@bounda-dev/cloudflare": minor
"@bounda-dev/cli": minor
"create-bounda": minor
---

Every adapter declares where it keeps its data (articles 30(1)(e) and 44 to 49). `sqlite()`, `postgresql()` and `memory()` take `location`, the jurisdiction their database keeps its data in, such as `"eu"` (`DataLocationOptions`, from `@bounda-dev/core/adapter`); `cloudflare({ jurisdiction })` declares its jurisdiction as its location, now written `"eu"` rather than `"jurisdiction eu"`, as `defineTenantKeyStore` and `defineForgetLedger` take it too, and `masterKey({ from, location })` and `defineKeyWrapper(create, { location })` declare where the master key is kept. The location `storage` declares is the app's: the app refuses to start, and `bounda personal-data inventory` to run, on a read model, tenant key store, forget ledger or key wrapper that declares another or none, whatever its adapter, since encryption protects data from a transfer only while its keys stay behind, so a read model on PostgreSQL or Turso is now held to a Cloudflare app's jurisdiction too; a location that is not a non-empty name is refused anywhere. The record of processing states the location of every holder and record, lists the master key (`master-key`) and the tenant key store (`tenant-keys`) as records of their own, and reports each store of personal data, and the key wrapper, that declares no location as a `no-location` finding, which makes the command exit `1`; the CLI prints a location as `postgresql, in eu`. Projects from `create-bounda` on Node declare `location: "eu"` on their storage, tenant key store and master key, and those on Cloudflare on their master key.
