---
"@bounda-dev/react-router": patch
"create-bounda": patch
---

`failure` from `@bounda-dev/react-router/app` turns what a command throws into an action's answer:
a `ValidationError` becomes a 400 with its `issues`, a `DomainError` a 409 with its code in
`rejected`, and anything else is rethrown for the route's `ErrorBoundary`. Return it from the
action's `catch`. A React Router project from `create-bounda` imports it instead of carrying its
own copy in `app/errors.server.ts`, which becomes `app/form.server.ts` with the `field` helper
alone. `Failure`, the type of that `actionData`, is exported from `@bounda-dev/react-router`.
