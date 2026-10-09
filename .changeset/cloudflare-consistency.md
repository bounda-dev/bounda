---
"@bounda-dev/core": minor
"@bounda-dev/adapter-cloudflare": minor
"@bounda-dev/react-router": minor
---

On Cloudflare the host decides read-your-writes, as in React Router: `connect(stub, { consistency })`
and `createWorker({ consistency })` take `"read-your-writes"`, the default and the behaviour so
far, or `"eventual"`, under which a command answers once its events are stored and the object's
alarm brings the read models up to date right after; any other value throws
`ConfigurationError`. The `Consistency` type moves to
`@bounda-dev/core`; `@bounda-dev/react-router` no longer exports it.
