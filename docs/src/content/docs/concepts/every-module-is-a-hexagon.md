---
title: Every module is a hexagon
description: Why each aggregate and read model in Bounda declares its own ports, keeps their implementations beside it and has one chosen by name.
sidebar:
  order: 60
---

Alistair Cockburn's ports and adapters, the hexagonal architecture, wants an application that
users, programs and tests can drive alike, and that can be built and tested apart from the
devices and databases it will finally talk to. Each conversation with the outside goes through a
**port**, an interface the application defines for one purpose, and each technology plugs into it
through something that translates. A
real mail service, a console and an in-memory double are three ways to fill the same port.

The usual drawing puts one hexagon around the whole application. Bounda draws it smaller:
**every aggregate and every read model is its own hexagon**, with its ports at its root, their
implementations in its own `infrastructure/` and the choice between them made under its own name.
This page says why, and what it costs. How to write one is in
[Project layout](/guides/project-layout/#ports-portts).

## One module, one port, two implementations

The storefront's `order` aggregate tells customers their order was placed. The contract is a
file at the aggregate's root that exports an interface named after it:

```ts
// app/domain/order/notifier.ts
export interface NotifierArgs {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
  readonly idempotencyKey: string;
}

export interface Notifier {
  (args: NotifierArgs): Promise<void>;
}
```

It is a port because `infrastructure/notifier/` exists next to it, holding `console.ts` and
`memory.ts`; without that directory it would be one more module of the aggregate. Every handler of
`order` (its commands, its policies, every handler of its processes) receives `notifier` beside
its other arguments, and a handler of `payment` never does. The configuration picks one
implementation by aggregate and port, and a test hands in its own under the same key:

```ts
// bounda.config.ts
ports: { order: { notifier: process.env.NOTIFIER === "memory" ? "memory" : "console" } },

// tests/storefront.test.ts
ports: { order: { notifier: async (confirmation) => void sent.push(confirmation) } },
```

Both are typed from what the generator found and checked again at boot
([the rules](/guides/project-layout/#ports-portts)), and a test gets only the ports it passes.

## Implementations depend on their port

An implementation has no `+types` of its own. It imports its port and fulfils it, and `satisfies`
reports a mismatch in place; the generated registry checks every implementation against the
interface anyway, so one that does not fit fails `tsc` either way.

```ts
// app/domain/order/infrastructure/notifier/console.ts
import type { Notifier } from "../../notifier.ts";

export default (async ({ orderId, customerId, total, idempotencyKey }) => {
  console.log(
    `[notifier] confirmation for order ${orderId} sent to ${customerId} (${total}), key ${idempotencyKey}`,
  );
}) satisfies Notifier;
```

That file imports nothing from Bounda. An implementation with state, a client, a pool or a
secret, exports `create` instead, typed as `CreateImplementation<Port>`, the one type it takes from
Bounda, and each part of it has a reason: `env`, because the host's environment is `process.env`
in Node, the Durable Object's `env` on Cloudflare and what a test passes; the app's `logger`; the
app's `clock`, so the time it reads is the time a test controls; and a result that may be a
promise, for a client that must connect first. It runs once per app, so on Cloudflare once per
Durable Object: each tenant's store builds its own client, and `app.stop()` closes it.

## Why the contract is written, never inferred

The generator refuses a port whose module does not export the interface, and a port directory with
no implementation. It could have taken the type of the one implementation there is. It does not,
for two reasons. The contract comes first: it is what the aggregate needs from the world, written
before anyone picks a provider, and often while only a fake exists. And an inferred contract
would move with its implementation: a method added to the HTTP client for its own convenience
would appear in every handler, and one removed would break handlers that never mentioned the
implementation. Written down, the port changes only when someone changes what the domain asks.

## Read models have ports too, for their queries

A read model declares and implements ports the same way, and only the `handler` of its queries
receives them: a query that completes its rows with an exchange rate or a profile from outside.
Projections and `repository` get none. A projection commits exactly once per batch and replays its
whole history on a rebuild, so an outside call there would be repeated and could answer
differently the second time; the reasons are in
[Ports of a read model](/guides/read-models/#ports).

## Where it comes from, and the closest mechanics

- **Cockburn's [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture/)**
  (2005) names ports by purpose and lets one port have several adapters, a real database, a flat
  file or an in-memory mock among them. Bounda keeps the idea and moves the boundary inward.
- **Folders by role inside a feature.** Tom Hombergs' BuckPal layout
  ([Educative](https://www.educative.io/courses/hexagonal-architecture-web-apps/architecturally-expressive-package-structure),
  [repository](https://github.com/thombergs/buckpal)) puts outgoing ports in
  `account/application/port/out` and their adapters in `account/adapter/out/persistence`. Oliver
  Zihler's [folder structures](https://codeartify.substack.com/p/folder-structures) vary the names
  but keep the rule: the top folder is a business slice, technical splits go inside it. Bounda's
  slice is the aggregate, and its one technical split is `infrastructure/`.
- **DDD's infrastructure layer**, on which the domain never depends
  ([Microsoft's DDD guide](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/ddd-oriented-microservice)).
  Here that layer is one directory per module, with the dependency pointing the same way.
- **Elixir's behaviour and adapter.** The closest mechanics.
  [Swoosh](https://github.com/swoosh/swoosh) defines the `Swoosh.Adapter` behaviour, and each mailer
  names its adapter in config, a different one per environment and `Swoosh.Adapters.Test` in tests.
  [Ecto](https://ecto.hexdocs.pm/Ecto.Repo.html) names a repo's adapter in the module and keeps its
  settings in config. The difference is who writes the contract: there the library owns the
  behaviour; here each aggregate writes its own.
- **Laravel's [manager](https://laracasts.com/blog/the-manager-pattern-in-laravel)** offers one
  API over drivers chosen by a config value, as Storage, Cache and Queue do: one per capability,
  for the whole app.
- **Effect's services and layers.** A [tag](https://www.effect.website/docs/v3/api/effect/Context)
  names a service, a [layer](https://effect.website/docs/requirements-management/layers/) builds
  it, and the program is provided its layers at the top: the typed form of the app-wide ports
  discussed below.

## Why not the other ways

- **Ports of the app, injected by the host.** One bag of services handed to `boot()`, as a
  container of providers or an Effect layer at the top would be. It is less to learn, and it
  loses the locality: what an aggregate depends on is no longer in its folder, any handler could
  reach any service, and two aggregates that use one provider share one contract, so a change one
  needs reaches the other. In Bounda a provider two aggregates use is two ports, each with the
  operations its aggregate needs, and the client they share is an ordinary module outside
  `app/domain` and `app/read`, such as `app/lib/stripe.ts`, which both implementations import.
- **Implementations chosen in code.** An `if` in a factory, or a container's registration, can
  choose anything. A choice in `bounda.config.ts` can only name an implementation that exists,
  checked by the compiler and again at boot, and a test cannot reach a provider it did not ask for.

## Why "port" and "implementation"

Cockburn's own word for what fills a port is *adapter*, but in Bounda that word names the storage
packages, `@bounda-dev/adapter-sqlite` and its siblings, and one word for two things would make
every sentence ambiguous. *Driver* is what Laravel says, but in hexagonal vocabulary the driving
side is the one that calls in, a user, a test or a script, the opposite of what these are.
*Provider* is the word of dependency injection, where it means anything the container can inject
([NestJS](https://docs.nestjs.com/providers)), which says how a thing is delivered, not what
it is for. *Implementation* is the plain word TypeScript already uses for fulfilling an interface
(`implements`), and that is all one is here.

## What stays outside

- **Where SDKs are imported.** The layout puts every client and SDK under `app/**/infrastructure/**`
  or in a shared module those files import, so a lint rule scoped by path can hold the rest of the
  domain free of them. Bounda does not check imports itself.
- **Repeating a call.** A port is a seam, not a guarantee. A command handler may run again on a
  concurrency retry, and a reaction runs at least once, so a call through a port must be safe to
  repeat: pass the `idempotencyKey` the handler receives
  ([calling the outside world](/guides/calling-the-outside-world/)).
- **The calling side.** These are the ports the domain calls out through. What calls in, a route
  or a webhook, is the host's code, which dispatches commands and runs queries on the app.

## Where to read more

- [Ports](/guides/project-layout/#ports-portts) and
  [ports of a read model](/guides/read-models/#ports), for how to declare,
  implement and choose them.
- [Doubles](/guides/testing/#doubles), for what a test passes instead.
- [How Bounda runs](/concepts/how-it-runs/#the-way-out-one-store-per-tenant), for the store per
  tenant that `create` runs once for.
- The precedents, linked above: Cockburn, Hombergs and Zihler, Swoosh's
  [adapter behaviour](https://swoosh.hexdocs.pm/Swoosh.Adapter.html), Ecto, Laravel's manager,
  Effect's services and layers.
