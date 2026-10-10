---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
"@bounda-dev/sqlite": patch
"@bounda-dev/postgresql": patch
"@bounda-dev/cloudflare": patch
"@bounda-dev/react-router": patch
"create-bounda": patch
---

Tighten the JSDoc of the public API to what it guarantees, and correct the comments that no longer matched the code: `boundaMiddleware` is mounted with `export const middleware = [boundaMiddleware]`, `schemaVersion` follows the event's upcasts, and a superseded rebuild's abort does nothing.
