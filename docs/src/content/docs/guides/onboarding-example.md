---
title: The onboarding example
description: A React Router app that registers, welcomes and activates users, in the repository under examples/onboarding.
sidebar:
  order: 3
---

`examples/onboarding` in the repository is a React Router 8 app on Bounda. It runs on SQLite out
of the box and on PostgreSQL when `DATABASE_URL` is set.

```bash
git clone https://github.com/bounda-dev/bounda
cd bounda && pnpm install && pnpm build && pnpm generate
cd examples/onboarding
pnpm test
pnpm dev
```

## What happens when a user registers

1. The `/register` action dispatches `registerUser` and redirects to `/users/:userId`. The page
   already shows the user: the app in the context reads its own writes.
2. `UserRegistered` starts the process `user-onboarding`. Its handler schedules
   `requestWelcomeEmail` a minute later, which appends `WelcomeEmailRequested`. The policy
   `send-welcome-email-on-welcome-email-requested` sends the email through its `emailSender`
   collaborator (`email-sender.console` in the demo, `email-sender.memory` in the tests) and
   dispatches `recordWelcomeEmailSent`, which appends `WelcomeEmailSent`.
3. Activating the user completes the process. A registration nobody activates within a week hits
   the process time-out, which dispatches `expireRegistration`.
4. Two read models follow along: `users-directory`, paginated by `listUsers`, and `user-details`,
   with the timestamps of every step.

## Things worth copying

**The integration in one line.** `vite.config.ts` adds `bounda()` before `reactRouter()`; the
plugin generates the types and serves `@bounda-dev/react-router/app`, which `root.tsx` and the
routes import. Nothing in the app knows how Bounda boots.

**Storage from the environment.** `bounda.config.ts` picks the adapter:

```ts
const url = process.env.DATABASE_URL;

export default defineConfig({
  storage: url === undefined ? sqlite({ path: "./data/onboarding.db" }) : postgresql({ url }),
  policies: {
    user: {
      sendWelcomeEmailOnWelcomeEmailRequested: {
        emailSender: { use: process.env.EMAIL_SENDER ?? "console" },
      },
    },
  },
});
```

**A delayed effect.** The delay belongs to a command, so the scheduled command does not send
anything: it records the request as an event, and a policy reacting to that event makes the call,
after the commit, with an `idempotencyKey` that survives its retries. A policy rather than the
process, because a user activated before the minute is up completes the process and should still
get the email.

**A paginated query with defaults.** Fields with `.default()` are optional for callers and always
present in the repository and the handler:

```ts
export const payload = ({ z }: Query.PayloadArgs) =>
  z.object({
    page: z.int().positive().default(1),
    pageSize: z.int().positive().max(100).default(20),
  });

export const repository = async ({ table, page, pageSize }: Query.RepositoryArgs) => {
  const [users, total, active] = await Promise.all([
    table.findMany({
      orderBy: { field: "registeredAt", direction: "desc" },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    table.count(),
    table.count({ status: "active" }),
  ]);
  return { users, total, active };
};
```

The loader calls `listUsers({ page })` and the component gets `users`, `total`, `active`, `page`
and `pages` typed.

**Domain errors as form feedback.** `app/errors.server.ts` turns `ValidationError` into a 400 with
the issues and `DomainError` into a 409; the route components render `actionData.error`.

**Time in tests.** `tests/onboarding.test.ts` registers a user, advances the clock a minute and
checks the welcome email was sent; advances a week and checks the registration expired:

```ts
clock.advance(7 * DAY);
await app.processUntilIdle();
expect(await app.queries.getUserDetails({ userId })).toMatchObject({ status: "expired" });
```

The domain is tested on the in-memory adapter; the web app is compiled in CI with
`react-router typegen`, `tsc` and `react-router build`.
