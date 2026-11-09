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
`boundaMiddleware`, a `dispose()`, `failure` and `handleError`, wired to the generated registry and
typed for your project through `.bounda/register.d.ts`.

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
type. What the context holds is a `BoundaClient`: besides them, `getLag()`,
[`events`](/guides/reading-the-stream/), `deadLetters` and `rebuildReadModel`, the same on Node
and on Cloudflare.

## Errors from the domain

A command throws `ValidationError` when the payload does not match its schema and `DomainError`
when its handler rejects it, with the code in `rejected`. Return `failure(error)` from the action's
`catch`, as above, and the form gets them as `actionData`:

| Thrown | Status | `actionData` |
|---|---|---|
| `ValidationError` | 400 | `{ error, issues }`, each issue with the `path` of the field and its `message` |
| `DomainError` | 409 | `{ error, issues: [], rejected }`, the code the command declares |
| `IdempotencyKeyConflictError` | 422 | `{ error, issues: [] }`, the request's `Idempotency-Key` came back with another payload |

`failure` goes by the error's `code`, `VALIDATION_FAILED`, `DOMAIN_ERROR` or
`IDEMPOTENCY_KEY_CONFLICT`, so it answers the same for the refusals a Durable Object sends back on
Cloudflare, which arrive as plain errors.
Anything else is rethrown and reaches the route's `ErrorBoundary`. `Failure`, the shape of that
data, is exported from `@bounda-dev/react-router`.

## Logging errors

React Router logs what a loader, an action or the render throws, and its default `handleError`
logs the message and the stack, in production too. A message may quote what the code read, a
person's email included, and a log keeps it in the clear, where `forget` never reaches. So export
Bounda's `handleError` from `app/entry.server.tsx`, and call it from the render's `onError`:

```tsx
// app/entry.server.tsx
import { handleError } from "@bounda-dev/react-router/app";

export { handleError };

export default function handleRequest(/* … */) {
  // React Router's default entry, with `onError` calling
  // `void handleError(error, { request })` where the default calls `console.error(error)`.
}
```

It logs one line per error, `request failed` with the method, the error's class and, for one of
Bounda's, its `code`, under the rule of
[error text](/reference/observability/#error-text): the message, the stack and the request's path,
which may quote what a user typed, only with `runtime.telemetry.errorText: "include"` or
`BOUNDA_ERROR_TEXT=include`. Like the default, it skips a request the client aborted, and it
unwraps what React Router throws itself, such as no route matching, to the error inside. On Node
it writes to the console as `boot()` does, and follows the app's configuration once it has booted:
the dev server's `"include"` before that, `"omit"` in a build. On Cloudflare it writes JSON lines,
as the Durable Object does, and follows `BOUNDA_ERROR_TEXT` in the Worker's `env`, or else the
configuration once a request has imported it: it never waits for an import, which the Worker could
cancel once the response is sent.

`create-bounda` writes the whole file, React Router's default entry for the runtime with these two
changes: in an existing project, `react-router reveal entry.server` writes the default into `app/`
to start from. Without the file, or when it does not export `handleError`, the `bounda()` plugin warns
when the dev server or the build starts.

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

## Retrying a request safely

A request that times out on the way back, or a form submitted twice, dispatches its command
twice. When the request carries a key, the middleware gives every command it dispatches an
`idempotencyKey` derived from that key and the command's name, and the second arrival answers what
the first did, its rejection included, without running the command again. The key comes from the
`Idempotency-Key` header or, since a browser form sends no headers, from a hidden `idempotencyKey`
field, which `@bounda-dev/react-router/form` renders from a key the loader makes:

```tsx
import { createIdempotencyKey, IdempotencyKeyField } from "@bounda-dev/react-router/form";

export const loader = () => ({ idempotencyKey: createIdempotencyKey() });

// in the component
<Form method="post">
  <IdempotencyKeyField value={loaderData.idempotencyKey} />
  {/* the form's fields */}
</Form>
```

The host never makes a key up: a request with neither dispatches as before. What the key means,
its lifetime, how the field renews itself, and an action that dispatches two commands under one
key are in [idempotent commands](/guides/idempotent-commands/#keys-in-react-router).

## Who makes a request

Every event can say who acted: the `actor` in its metadata, an id the host names for the
request (see [Who acts](/concepts/ids-causation-and-correlation/#who-acts)). The plugin takes it
from an optional `app/actor.ts`, which exports `actor`, a function of what a middleware receives,
the `request`, the route's `params` and the `context`. With React Router's sessions it reads the
signed-in user:

```ts
// app/actor.ts
import type { ActorFunction } from "@bounda-dev/react-router";
import { getSession } from "./sessions.server";

export const actor: ActorFunction = async ({ request }) => {
  const session = await getSession(request.headers.get("Cookie"));
  return session.get("userId");
};
```

The middleware calls it once per request, before the loaders and actions run, and the client in
`context.get(bounda)` already acts as the id it returns: every command an action dispatches
carries it, and so does every event, the ones the policies and processes it starts write
included. `undefined` means nobody, such as a visitor who is not signed in, and those requests
act as nobody, as every request does without the file. When an earlier middleware authenticates
the request and puts the user in the context, read it from there,
`({ context }) => context.get(userContext)?.id`, and mount `boundaMiddleware` after it.

Return an id, never a name or an email: events keep it in the clear and are never deleted. An
action that acts for someone else binds the client again, as
`context.get(bounda).as("billing-service")`, which keeps the request's idempotency key and reads
its own writes as the context's client does. A file that does not export an `actor` function
fails the request saying so, and so does an actor that is not a string of 1 to 255 characters.
On Cloudflare the actor goes over RPC with every call, and the Durable Object acts as it. Adding
or removing `app/actor.ts` is picked up on the next request.

The [onboarding example](/examples/onboarding/) has
an `app/actor.ts` that reads a development sign-in, a cookie holding whatever id you type, so its
pages show who registered and who activated each user. It is no authentication; it stands where a
real session goes.

## Reading what you just wrote

Read models are updated by projections that run in the background, so a page reached right after a
command could be rendered before the read model has the row. By default the app in the context reads
its own writes: a command resolves once the read models that project its events have reached them,
and so does `forget`, and the redirect lands on a page that already shows them. The wait is bounded,
and what it waits for is in [reading your own writes](/guides/deployment/#reading-your-own-writes).
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
- The dev server logs the text of errors, message and stack, unless `bounda.config.ts` sets
  [`runtime.telemetry.errorText`](/reference/observability/#error-text); the built app does not,
  since an error's message may quote personal data. `BOUNDA_ERROR_TEXT` in the environment or in
  `.env` overrides both. On Cloudflare the app runs in its Durable Object: see below.
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
  under `app/domain` or `app/read` reloads both, and adding or removing `app/tenant.ts` or
  `app/actor.ts` is picked up on the next request.
- `react-router build` writes the Worker and its `wrangler.json`; `wrangler deploy` deploys it.
- Bounda loads no `.env` here: the Worker's variables and secrets come from Wrangler, locally from
  `.dev.vars`, and port implementations receive them as `env` in `create`.
- The configuration is the same bundle in development and in production, so the text of errors
  comes from `.dev.vars`: `BOUNDA_ERROR_TEXT=include` there makes the Durable Object's logs and
  `handleError` in the Worker carry it under `react-router dev` and `wrangler dev`, and a
  deployment, which never reads `.dev.vars`, logs without it. `create-bounda` writes that line.
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

export const { bounda, boundaMiddleware, dispose, handleError } = createBounda({
  boot: () => boot({ registry, importConfig: () => import("../bounda.config.ts") }),
});
```

Import the registry by value and the configuration through `importConfig`, as above, so that the
build bundles both and a change to either re-evaluates this file in development; `createBounda`
then stops the app booted before, and the next request boots a new one once that stop has
finished, so the two never hold the storage at the same time. Its options are `boot` (how to
create the app, `boot()` by default), `consistency`, `actor` (the function `app/actor.ts` would
export), `key` (where the running app is kept on `globalThis`, one app per key), and for
`handleError` a `logger` (`createConsoleLogger()` by default) and the `errorText` it follows before
an app has booted (`"omit"` by default). `dispose()` stops the running app and forgets it, and resolves
once every app booted under that key has stopped. Export `handleError` from
`app/entry.server.tsx` as [above](#logging-errors). Import `failure` from
`@bounda-dev/react-router`.

On Cloudflare, `createBounda` from `@bounda-dev/react-router/cloudflare` takes the configuration
and the tenant instead, and reads the binding from the Worker's `env`:

```ts
// app/bounda.server.ts
import { createBounda } from "@bounda-dev/react-router/cloudflare";
import config from "../bounda.config.ts";

export const { bounda, boundaMiddleware, handleError } = createBounda({
  config,
  tenant: ({ params }) => params.workspace ?? "default",
});
```

It takes `consistency`, `actor` and a `logger` for `handleError` (`workersLogger` from
`@bounda-dev/cloudflare` by default) too, and throws `ConfigurationError` when `storage` is not `cloudflare()`,
when the Worker has no such binding, without a `tenant` function, or for a `consistency` it does
not know.
