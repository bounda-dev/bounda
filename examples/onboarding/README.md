# Onboarding

User registration and activation on Bounda inside a React Router app. One `user` aggregate, a
process that sends a welcome email a minute after registering and expires registrations nobody
activates within a week, and two read models behind the pages.

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

`app/bounda.server.ts` declares the integration once:

```ts
export const { bounda, boundaMiddleware } = createBounda({ boot: () => boot({ registry }) });
```

`root.tsx` mounts `boundaMiddleware`, which boots the app on the first request and puts it in
the router context. Loaders and actions read it with `context.get(bounda)`. Importing the
registry by value keeps the running app in step with your code in development: editing a module
under `app/domain` or `app/read` re-evaluates `bounda.server.ts`, which stops the old app, and the
next request boots a fresh one from the new modules.

## Reading what you just wrote

Projections run in the background, so a redirect straight after a command can reach the page
before the read model has the row. The actions call `processUntilIdle()` after dispatching: it
runs every pending projection, policy and process, and the page that follows sees the result.
Under load, prefer showing the command's outcome directly and letting the read model catch up.
