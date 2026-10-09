---
title: Bounda with React Router
description: Boot the app once from a middleware, dispatch commands from actions and read queries from loaders.
sidebar:
  order: 8
---

`@bounda-dev/react-router` puts a running Bounda app in the router context of every request. It
works with React Router 8 in framework mode, on Node or [on Cloudflare](#on-cloudflare); the
middleware boots the app on the first request and loaders and actions read it with
`context.get(bounda)`.

The quickest start is a new project:

```bash
npm create bounda@latest my-app -- --framework react-router
```

To add Bounda to an existing React Router app:

```bash
npm install @bounda-dev/core @bounda-dev/react-router @bounda-dev/sqlite
npm install -D @bounda-dev/cli
```

## One line in `vite.config.ts`

```ts
import { bounda } from "@bounda-dev/react-router/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [bounda(), reactRouter()] });
```

The plugin does two things. It runs `bounda generate` when the dev server or the build starts and
after every change under `app/domain` and `app/read`, so there is no generator to keep running on
the side. And it serves `@bounda-dev/react-router/app`: the `bounda` context, the
`boundaMiddleware`, a `dispose()` and `failure`, wired to the generated registry and typed for
your project through `.bounda/register.d.ts`.

Bounda's modules live in the same `app/` directory as your routes: `app/domain` and `app/read`
next to `app/routes`, `app/root.tsx` and `app/routes.ts`. The generator only looks at those two
directories and ignores the rest.

Mount the middleware in the root route:

```tsx
// app/root.tsx
import { boundaMiddleware } from "@bounda-dev/react-router/app";
import type { Route } from "./+types/root";

export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];
```

## Actions dispatch, loaders query

```tsx
// app/routes/register.tsx
import { bounda, failure } from "@bounda-dev/react-router/app";
import { redirect } from "react-router";
import type { Route } from "./+types/register";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const userId = crypto.randomUUID();
  try {
    await context.get(bounda).commands.registerUser({
      userId,
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
    });
  } catch (error) {
    return failure(error);
  }
  return redirect(`/users/${userId}`);
};
```

```tsx
// app/routes/user.tsx
import { bounda } from "@bounda-dev/react-router/app";
import { data } from "react-router";
import type { Route } from "./+types/user";

export const loader = async ({ params, context }: Route.LoaderArgs) => {
  const user = await context.get(bounda).queries.getUserDetails({ userId: params.userId });
  if (user === null) throw data("User not found", { status: 404 });
  return user;
};
```

`commands` and `queries` are typed from the generated registry: payloads, options and results
are checked in the route module, and `loaderData` in the component carries the query's result
type. What the context holds is a `BoundaClient`: besides them, `getLag()`, `deadLetters` and
`rebuildReadModel`, the same on Node and on Cloudflare.

## Errors from the domain

A command throws `ValidationError` when the payload does not match its schema and `DomainError`
when its handler rejects it, with the code in `rejected`. Return `failure(error)` from the action's
`catch`, as above, and the form gets them as `actionData`:

| Thrown | Status | `actionData` |
|---|---|---|
| `ValidationError` | 400 | `{ error, issues }`, each issue with the `path` of the field and its `message` |
| `DomainError` | 409 | `{ error, issues: [], rejected }`, the code the command declares |

`failure` goes by the error's `code`, `VALIDATION_FAILED` or `DOMAIN_ERROR`, so it answers the
same for the refusals a Durable Object sends back on Cloudflare, which arrive as plain errors.
Anything else is rethrown and reaches the route's `ErrorBoundary`. `Failure`, the shape of that
data, is exported from `@bounda-dev/react-router`.

## When the client goes away

A command keeps going when the browser closes the tab: the request has already arrived, and
stopping it halfway would leave the user not knowing whether it happened. Its handler is still
bounded by `runtime.commands.timeout` (see
[Retries and timeouts](/guides/reacting-to-events/#retries-and-timeouts)). When an action should
give up with its request, pass the request's signal; the command is withdrawn until its events
start being stored, and the dispatch rejects with the signal's reason:

```ts
await context.get(bounda).commands.registerUser(payload, { signal: request.signal });
```

The option takes any signal, such as `AbortSignal.timeout(2_000)` for one action that must answer
sooner than the app's limit. On Cloudflare it only counts before the call leaves the Worker: RPC
cannot carry it into the Durable Object, where the command runs to the end.

## Reading what you just wrote

Read models are updated by projections that run in the background, so a page reached right after
a command could be rendered before the read model has the row. By default the app in the context
reads its own writes: a command resolves once the read models that project its events have
reached them, and the redirect lands on a page that already shows them. The wait is bounded, and
what it waits for is in [reading your own writes](/guides/deployment/#reading-your-own-writes).
Policies, processes and scheduled commands still run in the background.

```ts
bounda({ consistency: "eventual" });
```

`consistency: "eventual"` serves the app exactly as booted, and reads may lag behind writes. Use
it when a separate worker owns the projections and the pages tolerate the delay. On Cloudflare a
command then answers once its events are stored, and the Durable Object's alarm projects them
right after.

## Development and production on Node

- `react-router dev` boots the app on the first request. A change under `app/domain` or
  `app/read` regenerates the types, and the next request boots an app from the new modules; so
  does a change to `bounda.config.ts`. Nothing to restart, no second generator process; a layout
  that breaks a convention is reported in the terminal and the last good registry keeps serving.
  `react-router build` fails on it.
  Closing the dev server waits for a regeneration already running and drops one still waiting
  for its quiet time, so nothing writes to the project after the server has gone.
- `react-router typegen && tsc` still needs the generated files first, so keep
  `bounda generate` as a script for CI and fresh clones.
- `.env` is read when the app boots and never overrides a variable that is already set, so a
  change to it needs the dev server restarted. In development it is read from the project root;
  the built app reads it from the directory it runs in.
- `react-router build` bundles `bounda.config.ts` and the generated registry into the server
  build, so the build runs from wherever it is deployed, with no need to ship either file.
- A component that touches `@bounda-dev/react-router/app` gets a clear error: the client build
  receives a stub. Loaders, actions and middleware are where it belongs.
- In production `react-router-serve` runs the app with `runtime.role: "all"` unless
  `bounda.config.ts` says otherwise: the web process also runs the dispatcher and the scheduler.
  To split them, set `runtime: { role: "web" }` in the web deployment and run a second process with
  `role: "worker"` that calls `boot()` and `app.start()`.
- Booting fails loudly: the request that triggered it gets the error, and the next request tries
  again. Nothing exits the process.

## On Cloudflare

When `bounda.config.ts` sets `storage: cloudflare()`, the app runs in a Durable Object, one per
tenant, and React Router runs in the Worker in front of it, through
[`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/). Each loader
and action then reaches the tenant's object over RPC. The `bounda()` plugin, the routes and
`app/root.tsx` stay as above; the Worker needs four more things, which a new project gets from
`npm create bounda@latest my-app -- --runtime cloudflare --framework react-router`.

```bash
npm install @bounda-dev/core @bounda-dev/react-router @bounda-dev/cloudflare
npm install -D @bounda-dev/cli @cloudflare/vite-plugin wrangler
```

```ts
// vite.config.ts
import { bounda } from "@bounda-dev/react-router/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), bounda(), reactRouter()],
});
```

```ts
// workers/app.ts
import { createBoundaObject } from "@bounda-dev/cloudflare";
import { createRequestHandler } from "react-router";
import { registry } from "../.bounda/registry.ts";
import config from "../bounda.config.ts";

export const Store = createBoundaObject({ registry, config });

const handler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default { fetch: (request: Request) => handler(request) };
```

```jsonc
// wrangler.jsonc
{
  "name": "my-app",
  "main": "./workers/app.ts",
  "compatibility_date": "2026-09-21",
  "durable_objects": { "bindings": [{ "name": "STORE", "class_name": "Store" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Store"] }]
}
```

```ts
// app/tenant.ts
import type { TenantFunction } from "@bounda-dev/react-router/cloudflare";

// One store for every request. Name one per customer instead to keep their data apart.
export const tenant: TenantFunction = () => "default";
```

`app/tenant.ts` names the store each request reaches. It receives what a middleware does, the
`request`, the route's `params` and the `context`, so the tenant can come from the URL, such as
`({ params }) => params.workspace ?? "default"`, or from what an earlier middleware put in the
context, such as the signed-in user. It runs the first time a request uses `bounda`, once per
request. Every tenant is its own object with its own events and read models; a single tenant is a
choice, so there is no default, and without the file the first request fails saying what to
create.

The binding is `STORE` unless the configuration names another with `cloudflare({ binding })`.
What runs in the Worker is a client of the object, so there is no app to boot there: the first
request imports the configuration and `app/tenant.ts`, and `dispose()` does nothing. Policies,
processes and scheduled commands run in the object's alarm, as
[on the adapter](/adapters/cloudflare/#how-it-runs).

- `react-router dev` runs the Worker and the object in `workerd`, as in production. A change
  under `app/domain` or `app/read` reloads both, and adding or removing `app/tenant.ts` is picked
  up on the next request.
- `react-router build` writes the Worker and its `wrangler.json`; `wrangler deploy` deploys it.
- Bounda loads no `.env` here: the Worker's variables and secrets come from Wrangler, locally from
  `.dev.vars`, and port implementations receive them as `env` in `create`.
- With `storage: cloudflare()` but without `@cloudflare/vite-plugin`, the server runs in Node,
  which cannot import the Workers runtime, and the first request fails saying to add the plugin.

## Options

`bounda()` takes:

| Option | Default | What it does |
|---|---|---|
| `consistency` | `"read-your-writes"` | `"read-your-writes"` reads its own writes; `"eventual"` serves the app as booted. |
| `debounceMs` | `100` | Quiet time after a change before regenerating. |

## Without the plugin

`createBounda()` from `@bounda-dev/react-router` is what the served module calls on Node, and you
can call it yourself in a server module when the plugin does not fit:

```ts
// app/bounda.server.ts
import { boot } from "@bounda-dev/core/node";
import { createBounda } from "@bounda-dev/react-router";
import { registry } from "../.bounda/registry.ts";

export const { bounda, boundaMiddleware, dispose } = createBounda({
  boot: () => boot({ registry, importConfig: () => import("../bounda.config.ts") }),
});
```

Import the registry by value and the configuration through `importConfig`, as above, so that the
build bundles both and a change to either re-evaluates this file in development; `createBounda`
then stops the app booted before, and the next request boots a new one once that stop has
finished, so the two never hold the storage at the same time. Its options are `boot` (how to
create the app, `boot()` by default), `consistency` and `key` (where the running app is kept on
`globalThis`, one app per key). `dispose()` stops the running app and forgets it, and resolves
once every app booted under that key has stopped. Import `failure` from
`@bounda-dev/react-router`.

On Cloudflare, `createBounda` from `@bounda-dev/react-router/cloudflare` takes the configuration
and the tenant instead, and reads the binding from the Worker's `env`:

```ts
// app/bounda.server.ts
import { createBounda } from "@bounda-dev/react-router/cloudflare";
import config from "../bounda.config.ts";

export const { bounda, boundaMiddleware } = createBounda({
  config,
  tenant: ({ params }) => params.workspace ?? "default",
});
```

It takes `consistency` too, and throws `ConfigurationError` when `storage` is not `cloudflare()`,
when the Worker has no such binding, without a `tenant` function, or for a `consistency` it does
not know.
