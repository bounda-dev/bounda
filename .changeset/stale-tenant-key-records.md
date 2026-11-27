---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"@bounda-dev/cloudflare": minor
---

Find and remove the copies of a tenant's key that a move to another tenant key store leaves behind, and make forgetting a tenant remove them.

A tenant whose configuration moved it to another tenant key store left its record, its key wrapped under the master key, in the store it left: nothing listed or removed it, and a forgetting, which reaches only the named store, left that copy able to open the tenant's data.

- `TenantKeyStore` requires `remove(tenant, expected)`, which removes a record only while it is still at the revision read. A store of your own from `defineTenantKeyStore` must add it; the SQL stores, memory, KV and the keeper Durable Object have it.
- `inspectTenantKeys({ config, env, tenant, tenants })` reads every tenant key store the configuration can name, writing nothing: the tenants whose key, in any store, is under a previous master key, every copy of a tenant's record in a store its configuration does not name, judged against the named store, and what could not be read. `bounda tenant-key status` prints it, and exits with `2` while a store cannot be read or a forgotten tenant's key has a copy left: a view across stores that watches a rotation of the master key in Node before `rewrap-master` runs.
- `removeStaleTenantKeys({ ..., only, despiteLostKeys })` and `bounda tenant-key remove-stale [tenants...] [--despite-lost-keys]` remove those copies once the named store holds every key the copy holds, or the tenant's forgetting. The only copy of a key is never removed, one holding keys the named store lacks only when told, one in a store only each tenant's own writer writes (KV) never, and one in what proves to be the named store itself, told apart only as two definitions, never.
- `createApp({ project })` takes the whole project, as `boot()` now passes it (`boot({ tenants })` names the tenants with a configuration given directly): `forgetTenant` then removes every copy of the tenant's key the stores reach, and resolves `keyCopies` with those removed and those left, which calling it again tries again. `bounda forget-tenant` names each and exits with `2` while one is left. `TenantForgottenResult` gains `keyCopies`, `null` in an app without `project`.
