---
title: Idempotent commands
description: Let a client send a command again without running it twice, with the idempotencyKey option and the Idempotency-Key header.
sidebar:
  order: 9
---

A command can reach the app twice: the client retried after a timeout, the user clicked twice, a
webhook was delivered again. The aggregate rejects what it must (`placeOrder` again is
`AlreadyPlaced`), but a rejection is the wrong answer to a retry of a command that went through,
and a command the aggregate takes twice, such as adding a line, does its work twice. An
**idempotency key** names one dispatch, so a second arrival under it answers what the first did
instead of running again.

## The `idempotencyKey` option

```ts
const placed = await app.commands.placeOrder(payload, { idempotencyKey: key });
```

The first dispatch under a key runs the command and remembers what it answered, in the same
transaction as the events it stores. Every later dispatch with the same key, the same command and
the same payload answers the same without running the handler: the same `StoredDispatch`, its
`position` included, so [reading your own writes](/guides/deployment/#reading-your-own-writes)
waits for the same read models; the same `ScheduledDispatch` for a command with `delay`, which is
scheduled once; or the same rejection, thrown again as a `DomainError` with its code. A dispatch
that failed, with a `ConcurrencyError` after its retries, a `HANDLER_TIMEOUT` or an error of the
handler's, is not remembered, so the client's retry runs it.

Two dispatches racing for one key both run; one records its outcome and the other loses on the
key, rolls back whatever it stored, and answers what the key holds. The events land once.

The key names one command with one payload. The same key with another command, or with the same
command and another payload, is a bug of the caller, not a retry: the dispatch rejects with
`IdempotencyKeyConflictError` (`IDEMPOTENCY_KEY_CONFLICT`) and runs nothing. The payload is
compared as JSON, keys in any order.

A key is a string of 1 to 255 characters that the caller chooses, one per operation the client
means to do once, such as a UUID made when the form is submitted and sent again on every retry of
it. It is remembered for `runtime.commands.idempotencyKeyLifetime`, 24 hours by default; past it
the key is free for another command, and the scheduled-command worker purges the record from
`bounda_idempotency_keys` ([configuration](/reference/configuration/#commands)).
A rejection decided on a state that held someone's [personal data](/guides/personal-data/) is
remembered only until that person is forgotten: `forget` removes it, and the same key is then
decided again.

This is not the `idempotencyKey` a command handler receives: that one is the command's own id,
for the provider the handler calls, the same across the runs a concurrency conflict causes
([calling the outside world](/guides/calling-the-outside-world/#deciding-then-acting)). The
option is for whoever dispatches the command, and reaches the handler as `command.metadata`
does not: a replay never runs it.

## The `Idempotency-Key` header in React Router

The `boundaMiddleware` reads the `Idempotency-Key` header of every request and passes it as
`idempotencyKey` to every command the request dispatches, on Node and on Cloudflare alike, so an
action has nothing to add:

```tsx
// app/routes/register.tsx
export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  try {
    // Carries the request's Idempotency-Key, when the client sent one.
    await context.get(bounda).commands.registerUser({ userId: String(form.get("userId")) });
  } catch (error) {
    return failure(error);
  }
  return redirect("/users");
};
```

The client makes the key when the user submits and sends it again when it retries, so a retry
answers as the first attempt did. With a fetcher:

```ts
const key = crypto.randomUUID();
fetcher.submit(form, { method: "post", headers: { "Idempotency-Key": key } });
```

A key names one command, so an action that dispatches two under one header gets a conflict on the
second: derive one per command with `idempotencyKeyFor` from `@bounda-dev/core`, or pass
`idempotencyKey` yourself, which wins over the header.

```ts
const key = request.headers.get("Idempotency-Key");
const keyed = (effect: string) => (key === null ? {} : { idempotencyKey: idempotencyKeyFor(key, effect) });
await commands.reserveSeats(seats, keyed("reserve"));
await commands.placeOrder(order, keyed("place"));
```

`failure()` answers a conflict with a 422 ([errors from the domain](/guides/react-router/#errors-from-the-domain)).
The host never makes keys up: a request without the header dispatches as before.

## On Cloudflare

`connect(stub)` sends the option to the Durable Object with the command, where it works as
above; React Router on Cloudflare reads the header the same way. The JSON API of `createWorker`
takes `delay` and `correlationId` from the query string and no key.

## In a policy or a process

The commands a policy or process dispatches get the same ids on every retry of the run, so a
scheduled one is stored once and a provider sees one key
([what the runtime promises](/guides/reacting-to-events/#what-the-runtime-promises)); they rarely
need an `idempotencyKey` of their own. One they pass is recorded with the run's unit of work and
answered from it on a later run.

## Elsewhere

[Stripe's `Idempotency-Key`](https://docs.stripe.com/api/idempotent_requests) remembers the first
response for 24 hours and refuses the key with other parameters, which is where the lifetime and
the fingerprint come from; the IETF's
[Idempotency-Key header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
draft names the header and the 422 for a mismatched payload.
