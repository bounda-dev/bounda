---
"@bounda-dev/cloudflare": minor
"@bounda-dev/react-router": minor
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
"create-bounda": minor
---

Durable Objects can be kept in a jurisdiction, such as the EU. `cloudflare({ jurisdiction: "eu" })`
is the one place that names it: `createWorker`, React Router's Cloudflare hosts and the new
`tenantStub({ config, env, tenant })` reach every tenant's object in it, and an object created in
another jurisdiction, or in one when the configuration names none, refuses to start before it
stores anything, so no tenant is split between two objects. A read model on `cloudflare()` names
the same jurisdiction as `storage`. Where `workerd` runs locally, which has no jurisdictions, the
setting is ignored.

An adapter's definition can say where it keeps its data, `location`, and the record of processing
states it for every holder and record: `cloudflare, jurisdiction eu`. `bounda personal-data
inventory` now reads a Cloudflare project, whose modules import the Workers runtime, instead of
failing to load it.

Projects from `create-bounda` on Cloudflare keep their objects in the EU, and their tests reach
them through `tenantStub`.
