---
"@bounda-dev/adapter-cloudflare": patch
"@bounda-dev/core": patch
---

A Bounda Durable Object works the same on every compatibility date. Workers before the 2026
dates drop an error's own properties on the way across RPC, so `createWorker` answered 500 for a
domain error or an invalid payload; the object now answers each call with an outcome, and
`connect` and `createWorker` throw refusals again with `name`, `message`, `code` and `issues`.
A handler that throws is no longer reported as an unhandled rejection by workerd on those dates.
