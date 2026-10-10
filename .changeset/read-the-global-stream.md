---
"@bounda-dev/core": patch
"@bounda-dev/cloudflare": patch
"@bounda-dev/react-router": patch
---

A store's global stream can be read by position: `events.read({ after, limit })` returns the events
committed after `after`, in position order, at most `limit` of them (100 by default, up to 1,000),
the lifecycle events of processes included. Each comes whole, as it was stored: position, id,
aggregate, type, payload, timestamp and metadata, the payload in the shape its `schemaVersion`
names. Reading on from the last position returned never misses an event committed later. It is
on every client: the app from `createApp`, `boot()` and `createTestApp`, `connect(stub)` on
Cloudflare, where the Durable Object answers it as `readEvents`, and the `bounda` context of
React Router.
