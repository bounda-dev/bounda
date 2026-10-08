---
"@bounda-dev/react-router": patch
"create-bounda": patch
---

`failure` from `@bounda-dev/react-router/app` turns what a command throws into an action's answer:
a `ValidationError` becomes a 400 with its `issues`, a `DomainError` a 409 with its code in
`rejected`, and anything else is rethrown for the route's `ErrorBoundary`. Return it from the
action's `catch`. `Failure`, the shape of that data, is exported from `@bounda-dev/react-router`.
A React Router project from `create-bounda` imports `failure` instead of carrying its own copy in
`app/errors.server.ts`, which it no longer has.
