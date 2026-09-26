# Onboarding

User registration and activation on Bounda inside a React Router app. One `user` aggregate, a
process that asks for a welcome email a minute after registering and expires registrations nobody
activates within a week, a policy that sends that email, and two read models behind the pages.

```bash
pnpm install
pnpm generate        # .bounda/registry.ts, .bounda/types.ts and every +types
pnpm test            # the domain on the in-memory adapter
pnpm dev             # http://localhost:5173 on SQLite (data/onboarding.db)
```

To run on PostgreSQL, point `DATABASE_URL` at a database (see `.env.example`):

```bash
docker run --rm -d --name onboarding-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=onboarding -p 5432:5432 postgres:17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/onboarding pnpm dev
```

`pnpm build && pnpm start` serves the production build with `react-router-serve`.

## How Bounda gets into the routes

`vite.config.ts` is the whole integration:

```ts
export default defineConfig({ plugins: [bounda(), reactRouter()] });
```

The plugin runs `bounda generate` when the dev server or the build starts and after every change
under `app/domain` and `app/read`, and serves `@bounda-dev/react-router/app`: the `bounda`
context, the `boundaMiddleware` that `root.tsx` mounts, and `dispose`. Loaders and actions read
the app with `context.get(bounda)`. The served module imports the generated registry by value, so
editing a domain module re-evaluates it and the next request boots an app from the new code.
`register.d.ts`, also generated, types `bounda` for this project.
## Reading what you just wrote

Projections run in the background, so a redirect straight after a command could reach the page
before the read model has the row. The app the middleware puts in the context reads its own
writes: a command resolves once the read models reflect it, and the page that follows sees the
result. Policies, processes and scheduled commands still run in the background. Pass
`consistency: "eventual"` to `createBounda` to leave projections to the background as well.
