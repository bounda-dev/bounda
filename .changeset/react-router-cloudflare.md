---
"@bounda-dev/core": minor
"@bounda-dev/adapter-cloudflare": minor
"@bounda-dev/react-router": minor
"create-bounda": minor
---

React Router runs on Cloudflare. With `storage: cloudflare()` and `@cloudflare/vite-plugin`, the
`bounda()` plugin serves the app from the Worker: every loader and action reaches, through
`connect`, the Durable Object of the tenant that `app/tenant.ts` names, with the plugin's
`consistency`. Without that file the first request fails saying what to create.
`@bounda-dev/react-router/cloudflare` exports `createBounda({ config, tenant })` and
`TenantFunction` for a server module of your own.

Breaking:

- `createWorker` takes the configuration instead of a binding, and `tenantOf` is required:
  `createWorker({ config, tenantOf })`. The binding is `cloudflare({ binding })`, `"STORE"` by
  default, and the `x-bounda-tenant` header is no longer a default tenant: the Cloudflare project
  from `create-bounda` passes it as `tenantOf`.
- `@bounda-dev/core` exports `BoundaClient`, what a request sees of an app wherever it runs, and
  `BoundaApp` extends it. `connect` returns one and `@bounda-dev/adapter-cloudflare` no longer
  exports its own; the `bounda` context of `@bounda-dev/react-router` holds one too, so a loader
  reaches `commands`, `queries`, `getLag()`, `deadLetters` and `rebuildReadModel`, but not the
  rest of `BoundaApp`.

Also:

- `failure()` goes by the error's `code`, so it answers the refusals a Durable Object sends back,
  which arrive as plain errors, as it answers a `ValidationError` or a `DomainError`.
- `createBounda` from `@bounda-dev/react-router` imports `@bounda-dev/core/node` only when it boots.
- Under the `bounda()` plugin in Node, a configuration that imports the Workers runtime, as
  `cloudflare()` does, fails the boot with a `ConfigurationError` that says to add
  `@cloudflare/vite-plugin`.
