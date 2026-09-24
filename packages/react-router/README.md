<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.bounda.dev/wordmark-dark.svg" />
    <img src="https://docs.bounda.dev/wordmark-light.svg" alt="Bounda" width="160" />
  </picture>
</p>

# @bounda-dev/react-router

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dreact-router)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=react-router)

[Bounda](https://docs.bounda.dev) inside a React Router 8 app in framework mode: one middleware
boots the app and every loader and action reads it from the router context.

The quickest start is a new project:

```bash
npm create bounda@latest my-app -- --framework react-router
```

In an app you already have, add the Vite plugin:

```ts
// vite.config.ts
import { bounda } from "@bounda-dev/react-router/vite";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [bounda(), reactRouter()] });
```

The plugin runs `bounda generate` when the dev server or the build starts and after every change
under `app/domain` and `app/read`, and serves `@bounda-dev/react-router/app`:

```tsx
// app/root.tsx
import { boundaMiddleware } from "@bounda-dev/react-router/app";
export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];

// app/routes/orders.tsx
import { bounda } from "@bounda-dev/react-router/app";

export const loader = ({ context }: Route.LoaderArgs) =>
  context.get(bounda).queries.listOrders({ customerId: "ada" });

export const action = async ({ request, context }: Route.ActionArgs) => {
  await context.get(bounda).commands.placeOrder(await payloadOf(request));
  return redirect("/orders");
};
```

`commands` and `queries` are typed from your generated registry. The app in the context reads its
own writes, so a page reached right after a command already shows it; pass
`bounda({ consistency: "eventual" })` to leave projections to the background. `createBounda()` is
the same thing without the plugin, for a server module of your own.

## Status

0.x. Until 1.0 the API can still change between minor versions, and every change that breaks
something is called out in the changelog.

Docs: [docs.bounda.dev/guides/react-router](https://docs.bounda.dev/guides/react-router/). Source
and issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
