---
"@bounda-dev/core": minor
"@bounda-dev/adapter-cloudflare": minor
---

Read-your-writes waits for your events, not for everything. A command's result now carries
`eventTypes` and `position`, the place of its last event in the global stream, and
`app.catchUpReadModels({ through: result })` waits only for the read models that project one of
those types, only until they reach that position. A read model already there costs one checkpoint
read; one behind is projected by the caller when no other process holds it, and when the worker
is busy with it the caller reads its checkpoint again every 15 ms instead of queueing on its lock,
so a web request no longer keeps a database connection waiting or projects other users' events.
The wait runs outside the dispatcher's pass mutex, and it is bounded by
`runtime.dispatcher.catchUp.timeout` (2 s): past it the command resolves anyway and a warning names
the read models still behind. `readYourWrites`, and with it React Router's
`consistency: "immediate"`, and the Durable Object's commands use it. `catchUpReadModels()`
without arguments still catches every read model up.
