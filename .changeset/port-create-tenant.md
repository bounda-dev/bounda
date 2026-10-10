---
"@bounda-dev/core": patch
"@bounda-dev/cloudflare": patch
---

A port implementation's `create` receives the name of the store the app serves as `tenant`, so an
implementation that differs by tenant (a merchant account per venue, an API key per customer)
picks its credentials when it is built. On Cloudflare it is the name the Durable Object was
addressed by with `idFromName`; `createApp` and `createTestApp` take it as the `tenant` option;
under `boot()`, with one store, there is none.
