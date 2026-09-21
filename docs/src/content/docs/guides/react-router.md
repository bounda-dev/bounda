---
title: Bounda with React Router
description: Boot the app once from a middleware, dispatch commands from actions and read queries from loaders.
sidebar:
  order: 2
---

`@bounda-dev/react-router` puts a running Bounda app in the router context of every request. It
works with React Router 8 in framework mode; the middleware boots the app on the first request and
loaders and actions read it with `context.get(bounda)`.

```bash
npm install @bounda-dev/react-router
```

## Declare it once

Bounda's modules live in the same `app/` directory as your routes: `app/domain` and `app/read`
next to `app/routes`, `app/root.tsx` and `app/routes.ts`. `bounda generate` only looks at those
two directories and ignores the rest.

```ts
// app/bounda.server.ts
import { boot } from "@bounda-dev/core/node";
import { createBounda } from "@bounda-dev/react-router";
import { registry } from "../.bounda/registry.ts";

export const { bounda, boundaMiddleware } = createBounda({ boot: () => boot({ registry }) });
```

`boot()` loads `.env`, imports `bounda.config.ts` and creates the app. Passing the registry
imported by value, instead of letting `boot()` import it, matters in development: editing a module
under `app/domain` or `app/read` re-evaluates `bounda.server.ts`, and `createBounda` stops the
app booted before so that the next request boots one from the new modules.

Mount the middleware in the root route:

```tsx
// app/root.tsx
import type { Route } from "./+types/root";
import { boundaMiddleware } from "./bounda.server.ts";

export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];
```

## Actions dispatch, loaders query

```tsx
// app/routes/register.tsx
import { redirect } from "react-router";
import type { Route } from "./+types/register";
import { bounda } from "../bounda.server.ts";

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
import { data } from "react-router";
import type { Route } from "./+types/user";
import { bounda } from "../bounda.server.ts";

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
createBounda({ boot: () => boot({ registry }), consistency: "eventual" });
```

`consistency: "eventual"` serves the app exactly as booted, and reads may lag behind writes. Use
it when a separate worker owns the projections and the pages tolerate the delay. The same
behaviour is available to any host through `readYourWrites(app)` and `app.catchUpReadModels()`
from `@bounda-dev/core`.

## Development and production

- `react-router dev` boots the app on the first request and reboots it when your modules change.
  Nothing to restart.
- In production `react-router-serve` runs the app with `runtime.role: "all"` unless
  `bounda.config.ts` says otherwise: the web process also runs the dispatcher and the scheduler.
  To split them, set `runtime: { role: "web" }` in the web deployment and run a second process with
  `role: "worker"` that calls `boot()` and `app.start()`.
- Booting fails loudly: the request that triggered it gets the error, and the next request tries
  again. Nothing exits the process.

## Options

| Option | Default | What it does |
|---|---|---|
| `boot` | `() => boot()` | How to create the app. Return `boot({ registry, ... })` to pass options or a registry. |
| `consistency` | `"immediate"` | `"immediate"` reads its own writes; `"eventual"` serves the app as booted. |
| `key` | `"bounda.app"` | Where the running app is kept on `globalThis`. One app per key. |

`createBounda` also returns `dispose()`, which stops the running app and forgets it; the next
request boots again.

The [onboarding example](/guides/onboarding-example/) is a complete app built this way.
