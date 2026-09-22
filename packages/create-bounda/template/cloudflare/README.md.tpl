# {{name}}

An event-sourced app on [Bounda](https://bounda.dev), running on Cloudflare: one Worker and one
Durable Object per tenant, with the events, the read models and the scheduled work in the
object's own SQLite. Nothing else to run.

```bash
{{pm}} install          # also runs bounda generate (prepare)
{{pm}} test             # the domain, on an in-memory store
{{pm}} run dev          # wrangler dev on http://localhost:8787
{{pm}} run deploy       # wrangler deploy, to your Cloudflare account
```

Try it once `dev` is running:

```bash
curl -X POST localhost:8787/commands/placeOrder \
  -H 'content-type: application/json' -H 'x-bounda-tenant: acme' \
  -d '{"orderId":"018f6a5e-4c3c-7c1e-9d4b-0b2c4a1d8e01","customerId":"ada","total":42}'
curl -X POST localhost:8787/queries/listOrders \
  -H 'content-type: application/json' -H 'x-bounda-tenant: acme' \
  -d '{"customerId":"ada"}'
```

## Where things go

```
app/domain/order/           the order aggregate
app/read/orders/            a read model
bounda.config.ts            storage: cloudflare()
src/worker.ts               the Durable Object class and the HTTP API
wrangler.jsonc              the binding and the SQLite migration for the object
tests/orders.test.ts        the app on an in-memory adapter
```

`src/worker.ts` uses `createWorker`, a JSON API with no authentication: a starting point. An app
with users writes its own `fetch` and talks to its store with `connect(stub)`, which types
`commands` and `queries` from your modules. Each tenant is its own object; `x-bounda-tenant`
picks it, `default` without the header.

`.bounda/` and `+types/` are generated; they stay out of git.
