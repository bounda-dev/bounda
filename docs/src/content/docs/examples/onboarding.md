---
title: The onboarding example
description: A React Router app that registers, welcomes and activates users, in the repository under examples/onboarding.
sidebar:
  order: 1
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
   already shows the user: the app in the context reads its own writes. The form carries an
   idempotency key, so a registration sent twice registers once.
2. `UserRegistered` starts the process `user-onboarding`. A minute later the delayed policy
   `send-welcome-email-on-user-registered` sends the email through the user's `emailSender`
   port (its `console` implementation in the demo, `memory` in the tests) and
   dispatches `recordWelcomeEmailSent`, which appends `WelcomeEmailSent`.
3. The policy `schedule-activation-reminder-on-user-registered` dispatches
   `sendActivationReminder` three days ahead, with the address and the name it goes to. When it
   comes due, its handler sends the reminder through the same port, unless the user was activated
   meanwhile.
4. Activating the user completes the process. A registration nobody activates within a week hits
   the process timeout, which dispatches `expireRegistration`.
5. Two read models follow along: `users-directory`, paginated by `listUsers`, and `user-details`,
   with the timestamps of every step.
6. "Delete my data" on the user's page calls `forget`: the email and the name become unreadable in
   every event, the reminder still waiting is cancelled, and both read models delete the user's row
   before the redirect to `/users`, which reads its own writes after `forget` too.

## Things worth copying

**The integration in one line.** `vite.config.ts` adds `bounda()` before `reactRouter()`; the
plugin generates the types and serves `@bounda-dev/react-router/app`, which `root.tsx` and the
routes import. Nothing in the app knows how Bounda boots.

**Storage and ports from the environment.** `bounda.config.ts` picks the adapter and
the email sender:

```ts
const url = process.env.DATABASE_URL;

export default defineConfig({
  storage: url === undefined ? sqlite({ path: "./data/onboarding.db" }) : postgresql({ url }),
  ports: {
    user: { emailSender: process.env.EMAIL_SENDER === "memory" ? "memory" : "console" },
  },
});
```

**An implementation built from the environment.** The `console` email sender exports `create`
instead of a default: it reads its sender address from `EMAIL_FROM` in `env` and writes through
the app's logger, once, when the app starts:

```ts
// app/domain/user/infrastructure/email-sender/console.ts
import type { CreateImplementation } from "@bounda-dev/core";
import type { EmailSender } from "../../email-sender.ts";

export const create: CreateImplementation<EmailSender> = ({ env, logger }) => {
  const from = env.EMAIL_FROM ?? "welcome@onboarding.localhost";
  return async ({ to, name, idempotencyKey }) => {
    logger.info("welcome email", { from, to, name, idempotencyKey });
  };
};
```

**A delayed effect.** The policy exports `delay`, read from `WELCOME_EMAIL_DELAY`, so the runtime
runs it a minute after `UserRegistered` was stored, with an `idempotencyKey` that survives its
retries. It is a policy rather than the process because the email does not depend on what happens
in that minute: a user activated before it is up completes the process and still gets the email.

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

**Forms that can be sent again.** Every form that dispatches a command carries a hidden
idempotency key that its loader makes, and the middleware keys the commands with it
([keys in React Router](/guides/idempotent-commands/#keys-in-react-router)). Registering also
makes the user's id in the loader, so a registration sent again after a lost response is the same
registration, answered as the first, instead of `AlreadyRegistered`:

```tsx
// app/routes/register.tsx
export const loader = () => ({
  userId: crypto.randomUUID(),
  idempotencyKey: createIdempotencyKey(),
});

// in the component
<Form method="post">
  <input type="hidden" name="userId" value={loaderData.userId} />
  <IdempotencyKeyField value={loaderData.idempotencyKey} />
  {/* name and email */}
</Form>
```

Editing the form after a rejection, such as an id that does not exist on `/activate`, gives it a
fresh key, so the corrected request runs instead of conflicting with the first.

**Personal data, forgotten.** The email and the name are marked with `personal` wherever they
appear, in the events and in the payloads of the commands that carry them, the scheduled reminder
among them, and the person is the user, the aggregate's id
([personal data](/guides/personal-data/)):

```ts
// app/domain/user/user-registered.ts
export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()), name: personal(z.string().min(1)) });
```

Whoever reads the event sees `string | null`: the policies skip a user forgotten before they ran,
and the projections skip one a rebuild meets. Each read model projects
`PersonalDataForgotten`, which the generator requires once it shows a personal field:

```ts
// app/read/users-directory/projections/bounda/personal-data-forgotten.ts
export const project = async ({ event, table }: Projection.Args) => {
  await table.delete({ userId: event.payload.personId });
};
```

The reminder carries the address in its payload, marked too, so it waits encrypted until it comes
due, and `forget` cancels it: `PersonalDataForgotten` lists it in `cancelledCommands`.

**Who acts.** The header has a development sign-in: an id you type, such as `support-1`, kept in a
cookie by `app/dev-session.server.ts`, which checks nothing and stands where a real session goes.
`app/actor.ts` reads it ([who makes a request](/guides/react-router/#who-makes-a-request)):

```ts
// app/actor.ts
import type { ActorFunction } from "@bounda-dev/react-router";
import { devActorOf } from "./dev-session.server.ts";

export const actor: ActorFunction = ({ request }) => devActorOf(request);
```

Every command a page dispatches then carries the id, and so do its events and those of the
welcome email and the reminder that follow. The `user-details` projections keep it from
`event.metadata.actor`, so the user's page shows who registered and who activated them:

```ts
// app/read/user-details/projections/user/user-activated.ts
export const project = async ({ event, table }: Projection.Args) => {
  const { actor } = event.metadata;
  await table.update(
    { userId: event.aggregateId },
    {
      status: "active",
      activatedAt: new Date(event.timestamp),
      ...(actor === undefined ? {} : { activatedBy: actor }),
    },
  );
};
```

**Domain errors as form feedback.** Every action returns `failure(error)` from its `catch`, which
turns `ValidationError` into a 400 with the issues and a command's rejection, a `DomainError`, into
a 409 with its code; the route components render `actionData.error`.

**Time in tests.** `tests/onboarding.test.ts` registers a user, advances the clock a minute and
checks the welcome email was sent; advances a week and checks the registration expired:

```ts
clock.advance(7 * DAY);
await app.runUntilIdle();
expect(await app.queries.getUserDetails({ userId })).toMatchObject({ status: "expired" });
```

The domain is tested on the in-memory adapter; the web app is compiled in CI with
`react-router typegen`, `tsc` and `react-router build`.
