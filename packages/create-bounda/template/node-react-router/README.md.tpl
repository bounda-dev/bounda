# {{name}}

An event-sourced app on [Bounda](https://bounda.dev) inside a React Router app. One `order`
aggregate, one read model, a test, and a page that places orders from an action and lists them
from a loader.

```bash
{{installCommand}}  # also runs bounda generate (prepare)
{{testCommand}}  # the domain on an in-memory adapter
{{devCommand}}  # http://localhost:5173
{{buildCommand}} && {{startCommand}}
```

## Where things go

```
app/domain/order/           the order aggregate
  order-placed.ts           an event: payload and begin, which opens the order
  commands/place-order.ts   a command: payload and handler
app/read/orders/            a read model
  view.ts                   its fields
  projections/order/order-placed.ts   projects the order's OrderPlaced
  queries/list-orders.ts
app/routes/home.tsx         a loader that queries and an action that dispatches
app/root.tsx                mounts boundaMiddleware
app/entry.server.tsx        React Router's entry, with Bounda's handleError
vite.config.ts              plugins: [bounda(), reactRouter()]
bounda.config.ts            storage and ports
tests/orders.test.ts        the app on an in-memory adapter
```

The `bounda()` Vite plugin generates the types when the dev server starts and after every change
under `app/domain` and `app/read`, and serves `@bounda-dev/react-router/app`: the `bounda`
context for loaders and actions, the `boundaMiddleware` that boots the app, and the
`handleError` that `app/entry.server.tsx` exports, which logs what a request throws without its
message, which may quote personal data, except under the dev server. The
[React Router guide](https://docs.bounda.dev/guides/react-router/) has the details; the
[project layout guide](https://docs.bounda.dev/guides/project-layout/) covers every kind of
module.

`.bounda/`, `+types/` and `.react-router/` are generated; they stay out of git.
