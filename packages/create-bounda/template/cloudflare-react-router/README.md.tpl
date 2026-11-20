# {{name}}

An event-sourced app on [Bounda](https://bounda.dev) inside a React Router app, running on
Cloudflare: React Router in a Worker, and one Durable Object per tenant with the events, the read
models and the scheduled work in the object's own SQLite. Nothing else to run.

```bash
{{installCommand}}
{{testCommand}}  # the domain, and the store in its Durable Object, inside workerd
{{devCommand}}  # http://localhost:5173, the Worker and the object in workerd
{{deployCommand}}  # react-router build and wrangler deploy, to your Cloudflare account
```

`{{generateCommand}}` writes the typed registry under `.bounda/`, a `+types/` folder next to each
module, `worker-configuration.d.ts` from `wrangler.jsonc` and the route types under
`.react-router/`. The dev server keeps the registry and the route types in sync as you edit; run
it yourself after changing `wrangler.jsonc`, so your editor sees the bindings.

## Where things go

```
app/domain/order/           the order aggregate
app/read/orders/            a read model
app/routes/home.tsx         a loader that queries and an action that dispatches
app/root.tsx                mounts boundaMiddleware
app/entry.server.tsx        React Router's entry, with Bounda's handleError
app/tenant.ts               names the Durable Object each request reaches
bounda.config.ts            cloudflare({ jurisdiction: "eu" }), and the keeper of the keys
.dev.vars                   the master key, and the text of errors in the logs, for development
workers/app.ts              the Worker: React Router, and the Durable Object classes
vite.config.ts              plugins: [cloudflare(), bounda(), reactRouter()]
wrangler.jsonc              the bindings: Store, Keeper and their SQLite migration
tests/orders.test.ts        the domain, on an in-memory store
tests/store.test.ts         the store, in its Durable Object in workerd
```

Every request reaches the store `app/tenant.ts` names: `default`, for all of them. One store for
everyone is a choice; to keep each customer's data apart, name theirs there, from the URL or the
signed-in user. The [React Router guide](https://docs.bounda.dev/guides/react-router/#on-cloudflare)
has the details.

Every object is created in the EU and never leaves it, as `jurisdiction: "eu"` in
`bounda.config.ts` says, the keeper that holds each tenant's key and forget ledger included. An
object never moves: to place each one near its first request instead, take that line out before
the first deploy. `vite dev` and the tests run in workerd, which keeps every object on your machine.
See [data location](https://docs.bounda.dev/adapters/cloudflare/#data-location).

`app/entry.server.tsx` exports Bounda's `handleError`, so what a loader or an action throws is
logged without its message, which may quote personal data, unless `BOUNDA_ERROR_TEXT=include`
says otherwise, as `.dev.vars` does in development for the Worker and the Durable Object alike.
See [logging errors](https://docs.bounda.dev/guides/react-router/#logging-errors).

`.bounda/`, `+types/` and `.react-router/` are generated; they stay out of git.
