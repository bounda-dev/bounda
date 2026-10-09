---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
"@bounda-dev/adapter-cloudflare": patch
---

A port implementation can export `create` instead of a default, never both, to build the
port when the app starts: a client, a pool, a secret. It receives `{ env, logger, clock }`, may be
async and runs once per app: once per process under `boot()`, once per Durable Object, once per
`createTestApp`. `env` is the host's environment: `process.env` after `.env` is loaded under
`boot()`, the Durable Object's `env` on Cloudflare (typed as `Cloudflare.Env`, which
`@bounda-dev/adapter-cloudflare` registers with `@bounda-dev/core/register`), and what a test
passes as `createTestApp({ env })`, an empty object otherwise. `createApp` takes `env` as well;
both require it when the registered environment is one an empty object does not satisfy, as
`Cloudflare.Env` is, and some implementation of the registry exports `create` (`EnvSection`).
`CreateAppArgs` and `CreateTestAppArgs` become type aliases.
`app.stop()` calls `[Symbol.asyncDispose]` on what each `create` returned, after closing the
storage and in reverse order; one that fails to close is logged and the rest still close. A
default export is never closed.

`create` is typed as `CreateImplementation<Port>`; `CreateArgs`, `CreateImplementation`, `AppEnv`
and `EnvSection` are new public types, and
`ImplementationModule` accepts either export. The registry check rejects a module that exports
both or neither. Run `bounda generate` to update generated files.
