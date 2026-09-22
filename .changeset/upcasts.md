---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
---

Upcasts. When an event's payload changes shape after events are stored, `<event>.upcast.ts`
next to the event exports `upcasts`: one function per past version, oldest first, the last one
producing today's payload, which `Event.Upcasts` from the event's `+types` checks. The runtime
stamps new events with `schemaVersion = upcasts.length + 1` and, on every read, applies the
upcasts from the stored version on, so `apply`, policies, processes, projections and rebuilds only
ever see the current shape. An event written with a version the running code does not know is
refused. The generator recognises the module and emits it under `upcasts` in the registry.
