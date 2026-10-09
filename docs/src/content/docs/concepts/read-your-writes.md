---
title: The host decides read-your-writes
description: Why a query right after a command may not see it, why the wait for the read models belongs to the host that serves the request and not to the core, and what the core offers for it.
sidebar:
  order: 41
---

A command in Bounda commits its events and returns. The read models learn about them afterwards:
each projection is a subscriber of the global stream, and a dispatcher pass moves it past the new
events ([how Bounda runs](/concepts/how-it-runs/#one-global-stream-per-store)). Between the commit
and that pass, a query reads the read model as it was. That gap is what eventual consistency means
in practice, and most of the time nobody notices it.

A form submission notices it. In the [onboarding example](/examples/onboarding/), the `register`
action dispatches `registerUser` and redirects to `/users/<id>`, whose loader asks `getUserDetails`
for the row and answers 404 when there is none. Without a wait, a redirect that lands before the
`user-details` projection has run tells the user who just registered that they do not exist. React
Router makes this the common case, not the rare one: once an action completes, it
[revalidates every loader on the page](https://reactrouter.com/start/framework/actions).

**Whether a request has to wait for its own writes is something only the host serving the
request knows**, so the host decides it. The core offers the means and no default.

## What the core offers

Two primitives in `@bounda-dev/core`, both working in every role:
`app.catchUpReadModels({ through })` waits for the read models a command's events reach, and only
those, and `readYourWrites(app)` returns the app with a `commands` facade that does it after every
dispatch. The wait is bounded, and the commands policies and processes dispatch never wait.
[Reading your own writes](/guides/deployment/#reading-your-own-writes) has how they wait and
their settings.

## Who decides, and how

- **React Router.** `createBounda({ consistency })`, or `bounda({ consistency })` in the Vite
  plugin, defaults to `"read-your-writes"`: the app it puts in every request's context is wrapped
  in `readYourWrites`. `"eventual"` serves the app as booted, for pages that tolerate the delay
  ([Reading what you just wrote](/guides/react-router/#reading-what-you-just-wrote)).
- **Cloudflare.** `connect(stub, { consistency })` and `createWorker({ consistency })` default to
  `"read-your-writes"`: the Durable Object's command call runs `catchUpReadModels({ through })`
  after the dispatch and before it answers, so the projections run inside the command's request.
  `"eventual"` answers once the events are stored, and the object's alarm projects them right
  after. Policies, processes and scheduled commands run in the alarm either way
  ([how it runs](/adapters/cloudflare/#how-it-runs)).
- **Anything else.** A script, a test or another framework picks: `readYourWrites(app)`, one
  `catchUpReadModels` where it matters, or nothing. The storefront's script dispatches and then
  calls `runUntilIdle()`, which is right for a script that wants every consequence before it
  prints.

## Why not the other ways

- **`runUntilIdle()` in every action.** It looks like the simple answer, and it is the wrong
  amount of work. It runs every subscriber, policies and processes included, so a policy that
  calls a slow provider would hold the request; and it runs due scheduled commands. It goes on
  until nothing moves, with no time limit. It ignores the back-off, so every request would trip
  over a failing projection again. And it waits on a read model's lock, which on PostgreSQL holds
  a connection while another instance finishes its batch. `catchUpReadModels({ through })` does
  the one part a page needs: the read models this command touched, up to this command.
- **A consistency default in the core.** Most dispatches have no read behind them: a worker, an
  import script with ten thousand commands, a webhook that answers 200. A default in the core
  would make all of them pay for a read they never do, or make each turn it off. Where a read
  follows is a fact about the request, which the core never sees; the host does, which is why
  React Router and Cloudflare each take it as a setting of their own.

## What other frameworks do

- **Marten** lets a projection be **inline**, updated in the same unit of work, and the same
  database transaction, as the events; **async**, run by a daemon in the background and
  eventually consistent; or **live**, built on demand. For async ones it offers
  `QueryForNonStaleData`, which waits for the daemon to reach the event store's position when the
  query started, and warns it can time out or slow responses down
  ([projections](https://martendb.io/events/projections/),
  [reading aggregates](https://martendb.io/events/projections/read-aggregates)).
- **EventStoreDB/Kurrent** returns the commit position of an append, and its docs suggest using it
  when redirecting a user to an eventually consistent view
  ([appending events](https://docs.kurrent.io/clients/python/v1.1/appending-events)).
- **Axon** pushes instead of waiting: a
  [subscription query](https://docs.axoniq.io/axon-framework-reference/4.11/queries/query-dispatchers/)
  returns an initial result and then the updates a projection emits after it changes its model, so a
  client sees a write when its update arrives instead of by asking again.

Bounda takes Kurrent's idea, a write's position, and builds the wait on it: a command's result
carries its position, and the request waits for checkpoints to reach it, bounded, and only for the
read models the command touched. It has no inline projections, and could not have them for a read
model in a [database of its own](/guides/deployment/#more-than-one-instance), which no transaction
of the event store reaches.

## What stays outside

- **Your own writes, not everyone's.** A command waits for its own position; another user's
  command committed a moment later may not be there yet.
- **Reactions.** What a policy or a process does in response, a payment, a confirmation, lands
  later. A page that shows it has to say it is pending, or poll.
- **A stale page, not a hang.** Past the timeout, or with a failing projection, the request reads
  what is there. The warning it logs is how you find out.
- **A query in a handler.** Inside a policy or a process, a query sees what was committed before
  the attempt, never what the attempt has staged
  ([what stays outside the outbox](/concepts/event-store-as-outbox/#what-stays-outside)).

## Where to read more

- [Reading your own writes](/guides/deployment/#reading-your-own-writes), for the API and the
  settings, and [Bounda with React Router](/guides/react-router/#reading-what-you-just-wrote).
- [The Cloudflare adapter](/adapters/cloudflare/#how-it-runs), for read models in the command's
  request or in the alarm, and reactions in the alarm.
- The other frameworks: Marten's [projections](https://martendb.io/events/projections/) and
  [inline projections](https://martendb.io/events/projections/inline.html), Kurrent's
  [appending events](https://docs.kurrent.io/clients/python/v1.1/appending-events), Axon's
  [subscription queries](https://docs.axoniq.io/axon-framework-reference/4.11/queries/query-dispatchers/),
  and React Router's [actions](https://reactrouter.com/start/framework/actions).
