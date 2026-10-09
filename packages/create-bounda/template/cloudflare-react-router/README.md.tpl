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
app/tenant.ts               names the Durable Object each request reaches
bounda.config.ts            storage: cloudflare()
workers/app.ts              the Worker: React Router, and the Durable Object class
vite.config.ts              plugins: [cloudflare(), bounda(), reactRouter()]
wrangler.jsonc              the binding and the SQLite migration for the object
tests/orders.test.ts        the domain, on an in-memory store
tests/store.test.ts         the store, in its Durable Object in workerd
```

Every request reaches the store `app/tenant.ts` names: `default`, for all of them. One store for
everyone is a choice; to keep each customer's data apart, name theirs there, from the URL or the
signed-in user. The [React Router guide](https://docs.bounda.dev/guides/react-router/#on-cloudflare)
has the details.

`.bounda/`, `+types/` and `.react-router/` are generated; they stay out of git.
