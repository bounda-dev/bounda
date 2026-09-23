---
"@bounda-dev/core": patch
"@bounda-dev/adapter-postgresql": patch
"@bounda-dev/adapter-cloudflare": patch
---

A read model rebuild can run in slices and resumes where it stopped. `rebuildReadModel` and
`app.rebuildReadModel` take `maxEvents` and answer `done`; the position reached is saved after
every batch, keyed by a fingerprint of the read model's fields and projections, so an interrupted
`bounda rebuild` picks up where it was unless the code changed, and `app.pendingRebuilds()` lists
what is waiting. On Cloudflare the Durable Object runs the first slice in the request and the
rest in its alarm (`eventsPerRebuildSlice`, 5,000 by default). Adapters gain `resume` and
`pause` in their rebuild.
