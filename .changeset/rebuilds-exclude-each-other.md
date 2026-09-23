---
"@bounda-dev/core": minor
"@bounda-dev/adapter-postgresql": minor
"@bounda-dev/adapter-sqlite": minor
"@bounda-dev/adapter-cloudflare": minor
---

Two rebuilds of the same read model no longer write at once. They used to share the shadow table
and its progress, so the second could drop the table the first was filling, and either could swap
in rows the other had half written. Opening a rebuild now claims the next generation of that read
model under a lock, and every batch, the commit and the abort go ahead only while that generation
is still the latest: the rebuild started last takes over, resuming where the other got when the
code is the same, and the older one stops at its next step with the new `RebuildSupersededError`
(`REBUILD_SUPERSEDED`) without writing or dropping anything. A rebuild whose process died needs no
timeout to be replaced. `rebuildFencing` in `@bounda-dev/core/adapter` names the lock and the
generation checkpoint for adapter authors.

On Cloudflare, an alarm slice that another rebuild took over is logged at `info` as
`bounda rebuild slice taken over by another rebuild` instead of as a failed slice, and is not
retried as one: the rebuild that took over carries on.
