---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
"@bounda-dev/adapter-sqlite": patch
"@bounda-dev/adapter-postgresql": patch
---

Rebuild a read model without taking it offline. `bounda rebuild <read-model>` projects the whole
stream into a fresh table with the view's current fields while queries keep reading the live one,
then swaps the two in a single transaction and moves the read model's checkpoint to where the
rebuild stopped; a worker that got further re-projects the difference. It is the path for a
projection that had a bug and for a view that lost a field or changed a field's type, which the
app still refuses to do on start, now naming the command. `rebuildReadModel` and
`app.rebuildReadModel(name)` in `@bounda-dev/core`, `loadProject` in `@bounda-dev/core/node`,
and `rebuildReadModel` in the adapter SPI; the in-memory adapter now shares one storage per
instance so that a rebuild sees the same events as the app.
