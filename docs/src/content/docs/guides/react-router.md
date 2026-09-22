---
title: Bounda with React Router
description: Boot the app once from a middleware, dispatch commands from actions and read queries from loaders.
sidebar:
  order: 2
---

`@bounda-dev/react-router` puts a running Bounda app in the router context of every request. It
works with React Router 8 in framework mode; the middleware boots the app on the first request and
loaders and actions read it with `context.get(bounda)`.

The quickest start is a new project:

```bash
npm create bounda@latest my-app -- --framework react-router
```

To add Bounda to an existing React Router app:

```bash
npm install @bounda-dev/core @bounda-dev/react-router @bounda-dev/adapter-sqlite
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
`boundaMiddleware` and a `dispose()`, wired to the generated registry and typed for your project
through `.bounda/register.d.ts`.

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
import { bounda } from "@bounda-dev/react-router/app";
import { redirect } from "react-router";
import type { Route } from "./+types/register";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  const userId = crypto.randomUUID();
  await context.get(bounda).commands.registerUser({
    userId,
    email: String(form.get("email")),
    name: String(form.get("name")),
  });
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
type.

## Errors from the domain

A command throws `ValidationError` when the payload does not match its schema and `DomainError`
when a rule rejects it. Map them once and return them as data, so the form can show them:

```ts
// app/errors.server.ts
import { DomainError, ValidationError } from "@bounda-dev/core";
import { data } from "react-router";

export const failure = (error: unknown) => {
  if (error instanceof ValidationError) {
    return data({ error: error.message, issues: error.issues }, { status: 400 });
  }
  if (error instanceof DomainError) return data({ error: error.message, issues: [] }, { status: 409 });
  throw error;
};
```

Anything else propagates to the route's `ErrorBoundary`.

## Reading what you just wrote

Read models are updated by projections that run in the background, so a page reached right after
a command could be rendered before the read model has the row. By default the app in the context
reads its own writes: a command resolves once the read models reflect its events, and the redirect
lands on a page that already shows them. Policies, processes and scheduled commands still run in
the background.

```ts
bounda({ consistency: "eventual" });
```

`consistency: "eventual"` serves the app exactly as booted, and reads may lag behind writes. Use
it when a separate worker owns the projections and the pages tolerate the delay. The same
behaviour is available to any host through `readYourWrites(app)` and `app.catchUpReadModels()`
from `@bounda-dev/core`.

## Development and production

- `react-router dev` boots the app on the first request. A change under `app/domain` or
  `app/read` regenerates the types, and the next request boots an app from the new modules.
  Nothing to restart, no second generator process; a layout that breaks a convention is reported
  in the terminal and the last good registry keeps serving. `react-router build` fails on it.
- `react-router typegen && tsc` still needs the generated files first, so keep
  `bounda generate` as a script for CI and fresh clones.
- `.env` is read when the app boots and never overrides a variable that is already set, so a
  change to it needs the dev server restarted.
- A component that touches `@bounda-dev/react-router/app` gets a clear error: the client build
  receives a stub. Loaders, actions and middleware are where it belongs.
- In production `react-router-serve` runs the app with `runtime.role: "all"` unless
  `bounda.config.ts` says otherwise: the web process also runs the dispatcher and the scheduler.
  To split them, set `runtime: { role: "web" }` in the web deployment and run a second process with
  `role: "worker"` that calls `boot()` and `app.start()`.
- Booting fails loudly: the request that triggered it gets the error, and the next request tries
  again. Nothing exits the process.

## Options

`bounda()` takes:

| Option | Default | What it does |
|---|---|---|
| `consistency` | `"immediate"` | `"immediate"` reads its own writes; `"eventual"` serves the app as booted. |
| `debounceMs` | `100` | Quiet time after a change before regenerating. |

## Without the plugin

`createBounda()` from `@bounda-dev/react-router` is what the served module calls, and you can call
it yourself in a server module when the plugin does not fit:

```ts
// app/bounda.server.ts
import { boot } from "@bounda-dev/core/node";
import { createBounda } from "@bounda-dev/react-router";
import { registry } from "../.bounda/registry.ts";

export const { bounda, boundaMiddleware, dispose } = createBounda({
  boot: () => boot({ registry }),
});
```

Import the registry by value, as above, so that a change in your modules re-evaluates this file
in development; `createBounda` then stops the app booted before and the next request boots a new
one. Its options are `boot` (how to create the app, `boot()` by default), `consistency` and `key`
(where the running app is kept on `globalThis`, one app per key). `dispose()` stops the running
app and forgets it.

The [onboarding example](/guides/onboarding-example/) is a complete app built this way.
