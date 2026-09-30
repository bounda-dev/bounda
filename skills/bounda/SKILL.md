---
name: bounda
description: Build event-sourced TypeScript apps with Bounda. Use when working in a project that has a bounda.config.ts, when the user mentions aggregates, commands, events, policies, processes, projections or read models in a Bounda codebase, or asks to add a feature to a Bounda app.
---

# Bounda

Bounda is an event sourcing and CQRS framework for TypeScript. An app is a tree of small modules
under `app/`; each file is one concept and exports the functions that concept needs. Types are
generated from the file layout, so you never write a registry or an argument type by hand.

## The two rules

1. **The file name and its folder are the declaration.** `app/domain/order/order-placed.ts` is the
   event `OrderPlaced` of the aggregate `order`. Names are kebab-case.
2. **Types come from `./+types/<file-name>`.** Every module starts with
   `import type { X } from "./+types/<same name>"` and annotates its exports with `X.<Something>Args`.
   Run `bounda generate` after adding, renaming or deleting a module; `bounda generate --watch`
   keeps up while you work.

Never edit anything under `.bounda/` or a `+types/` directory; both are generated and gitignored.

## Layout

```
app/domain/<aggregate>/
  state.ts                         optional: export const initialState = {...}; export const aggregateId = "<field>"
  <event>.ts                       export const payload (optional), export const apply
  <event>.upcast.ts                optional: export const upcasts (oldest version first)
  commands/<command>.ts            export const payload, export const handler
  commands/<command>/index.ts      same, with <collaborator>.<implementation>.ts files beside it
  policies/<action>-on-<event>.ts  export const handler; on and delay optional
  policies/<action>-on-<event>/index.ts   same, with <collaborator>.<implementation>.ts files beside it
  policies/<other-aggregate>/...   the same shapes, reacting to that aggregate's events
  processes/<process>/index.ts     export const config, export const state (optional)
  processes/<process>/on-<event>.ts, at-<deadline>.ts, at-timeout.ts   export const handler
  processes/<process>/<other-aggregate>/on-<event>.ts  handler for that aggregate's event
  processes/<process>/<collaborator>.<implementation>.ts   collaborators of every handler of the process
app/read/<read-model>/
  view.ts                          export const fields
  projections/<aggregate>/<event>.ts   export const project
  queries/<query>.ts               export const payload (optional), repository (optional), handler
bounda.config.ts                   export default defineConfig({ storage, readModels?, runtime?, commands?, policies?, processes? })
```

## Templates

Event:

```ts
import type { Event } from "./+types/order-placed";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ total: z.number().positive() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  status: "placed" as const,
  total: event.payload.total,
});
```

Command (the payload must carry the aggregate id field, `orderId` for `order` unless `state.ts`
says otherwise):

```ts
import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/pay-order";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ orderId: z.uuid(), method: z.enum(["card", "transfer"]) });

export const handler = ({ command, state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed") throw new DomainError("Only placed orders can be paid");
  return [events.orderPaid({ method: command.payload.method })];
};
```

Command with a collaborator (`commands/place-order/index.ts` plus `inventory.fake.ts` with a
default export; `bounda.config.ts` selects it with `commands: { placeOrder: { inventory: { use: "fake" } } }`):

```ts
export type Collaborators = { inventory: { available: (skus: readonly string[]) => Promise<boolean> } };

export const handler = async ({ command, events, inventory }: Command.HandlerArgs) => {
  if (!(await inventory.available(command.payload.skus))) throw new DomainError("Out of stock");
  return [events.orderPlaced(command.payload)];
};
```

Command handlers decide; they do not act on the world. A handler reruns, collaborators included,
when its append loses a concurrency race, and its decision is not stored until the append
succeeds. So its collaborator calls must be safe to repeat and harmless if the decision never
lands: a read, or a call the provider deduplicates, such as creating a payment intent. Every
handler receives `idempotencyKey`, stable across its reruns (the command id); pass it to those calls.

Effects (charging, emailing, calling another service) go in a policy or process with the
collaborator, after the event is stored, passing `idempotencyKey` to the provider, and report back
with a command whose handler ignores a duplicate by state. A provider's refusal becomes an event
(`PaymentFailed`); throw only when there is no answer.

Policy (`policies/issue-invoice-on-order-paid.ts`):

```ts
import type { Policy } from "./+types/issue-invoice-on-order-paid";

export const handler = async ({ event, commands }: Policy.HandlerArgs) => {
  await commands.issueInvoice({ orderId: event.aggregateId });
};
```

Policy with a collaborator (`policies/send-receipt-on-order-paid/index.ts` plus `mailer.smtp.ts`;
config `policies: { order: { sendReceiptOnOrderPaid: { mailer: { use: "smtp" } } } }`):

```ts
export const handler = async ({ event, commands, mailer, idempotencyKey }: Policy.HandlerArgs) => {
  await mailer.sendReceipt({ orderId: event.aggregateId }, idempotencyKey);
  await commands.recordReceiptSent({ orderId: event.aggregateId });
};
```

Process (`processes/order-payment/index.ts`, `on-order-placed.ts`, `at-payment-deadline.ts`,
`at-timeout.ts`). A deadline is a state field declared with `deadline()`; a handler schedules it
with `after("24h")`, moves it by changing it, cancels it with `null`; `at-<field>.ts` runs when it
comes due and returns the field as `null` or another moment. `instant()` only records a moment.
`at-timeout.ts` runs at `config.timeout` and ends the process as timed out:

```ts
import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderPaid, events.order.OrderCancelled],
  timeout: "7d",
});
export const state = ({ z, deadline, instant }: Process.StateArgs) =>
  z.object({ reminders: z.int().default(0), paymentDeadline: deadline(), paidAt: instant() });
```

```ts
import type { Process } from "./+types/on-order-placed";

export const handler = ({ state, after }: Process.HandlerArgs) => ({
  ...state,
  paymentDeadline: after("72h"),
});
```

```ts
import type { Process } from "./+types/at-payment-deadline";

export const handler = async ({ state, aggregateId, commands }: Process.DeadlineArgs) => {
  await commands.cancelOrder({ orderId: aggregateId, reason: "unpaid" });
  return { ...state, paymentDeadline: null };
};
```

Read model (`view.ts`, `projections/order/order-placed.ts`, `queries/get-order.ts`):

```ts
import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey(),
  status: f.string(),
  total: f.number(),
  paidAt: f.date().optional(),
});
```

```ts
import type { Projection } from "./+types/order-placed";

export const project = async ({ event, table }: Projection.Args) => {
  await table.upsert({ orderId: event.aggregateId, status: "placed", total: event.payload.total });
};
```

```ts
import type { Query } from "./+types/get-order";

export const payload = ({ z }: Query.PayloadArgs) => z.object({ orderId: z.uuid() });
export const repository = ({ table, orderId }: Query.RepositoryArgs) => table.findOne({ orderId });
export const handler = ({ repositoryData }: Query.HandlerArgs) => repositoryData;
```

## Rules of the runtime

- An event is identified by its aggregate and its type: two aggregates may both have `Cancelled`.
  A file reacts to events of the aggregate it sits in; a folder named after another aggregate
  (`policies/payment/`, `projections/payment/`) holds what reacts to that aggregate's events.
  Projections always sit in such a folder. A policy's trigger must be an event of the aggregate it
  listens to, or boot fails.
- A process `config` names events as `events.<aggregate>.<Event>`. For every event of another
  aggregate it uses, `index.ts` exports `correlate: Process.Correlate`, a function per event to the
  id of the process's own aggregate (or `null` to ignore it). Events for no open instance are
  skipped; a completed instance is never reopened. Returned state is validated against `state`.
- A command handler returns the events to append, built with `events.<eventKey>(payload)`. It may
  only build events of its own aggregate. Throw `DomainError` to reject a command.
- `state` in a handler carries `id` and `version` besides the aggregate's fields. Without
  `state.ts` every field is optional (`state.status === undefined` means a fresh aggregate).
- Policies and process handlers get `commands`, the typed facade of every command in the app, and
  run with at-least-once delivery: the runtime's inbox skips a handler that already completed for
  an event, but a handler that crashes midway runs again, so make its side effects idempotent. An
  attempt, a policy's or a process step's, stores its commands, immediate and delayed, together
  with its claim, its lifecycle events and its deadline entry when it ends, so a failed or crashed
  attempt leaves nothing behind, and a step whose instance moved meanwhile runs again on the new
  state; what `await commands.x()` returns is the aggregate's decision, not something stored yet:
  call outside first, dispatch after. Outside the promise: the outside calls themselves, the inbox
  claim, and what a read model shows a handler (only what was committed before the attempt).
- Policies and processes get their collaborators spread next to `event` and `commands`, like
  commands do. Config picks implementations by aggregate, then key:
  `policies: { order: { notifyOnOrderPlaced: { mailer: { use: "smtp" } } } }`, and the same
  under `processes`. A policy that exports `delay` (`"1m"`, or `asDuration(env)`) runs that long
  after the event, through the scheduler, with the same arguments and retries, but its runs are
  not ordered among themselves (each retries on its own); use it when the effect itself waits,
  and a delayed command when the decision must see the state at that time.
  Their `idempotencyKey` is the same on every retry for one event (for a
  deadline, one field at one moment) and new on a dead-letter replay. Their `signal` aborts when
  the run times out or fails: pass it to outside calls. A collaborator cannot be named after a
  handler argument (`event`, `commands`, `state`, `aggregateId`, `command`, `events`,
  `idempotencyKey`, `signal`, `after`).
- Process deadlines: `after()` counts from the event's time (in `at-`, from the moment that came
  due), so retries and late runs set the same moment and a daily chain catches up after an
  outage. Each deadline comes due once per moment, earliest first; nothing runs after the process
  ends. A handler's return is type-checked against the state in its `+types` (`ReturnCheck`):
  set deadlines with `after()` or `asInstant`, never a plain string. Boot refuses a `deadline()` without its `at-` file and the reverse. Build moments in tests
  with `asInstant`. For "do this later" without process state, keep a delayed command or policy.
- Projections write through `table` (`upsert`, `insert`, `update`, `delete`, `findOne`,
  `findMany`, `count`). Each batch is one transaction with the read model's
  checkpoint, so every event is applied exactly once and reading a row to update it
  (`count + 1`) is safe. That holds only for the read model: a projection must not call HTTP,
  other databases or timers; that work goes in a policy.
- A projection that keeps throwing stops its read model at that event: the events before it are
  kept, retries back off from 1 s to 30 s, and `app.getLag()` shows `failing` with the event and
  the error. Fix the projection and deploy; a read model never skips an event.
- Queries compose: a handler receives `queries` and may call other queries.
- Delayed commands: `commands.remindCustomer(payload, { delay: "24h" })`. The worker commits a
  scheduled run with the release of its claim, so a crash between the two never runs it twice. A duration from the
  environment is a `string`; wrap it: `{ delay: asDuration(process.env.DELAY ?? "24h") }`. The
  payload is stored as JSON and validated in that form at dispatch: a date field must be
  `z.coerce.date()`, since `z.date()` rejects the string a date becomes.
- Payload fields with `.default()` are optional for callers (`commands.x()`, `queries.x()` take
  the schema's input type) and always present in handlers (output type).
- A command resolves when its events are stored; read models catch up in the background.
  `app.catchUpReadModels()` runs the projections now; `readYourWrites(app)` returns an app whose
  commands wait, for at most 2 s, for the read models that project their events to reach them.
  Hosts such as the React Router package apply it for you.

## Bounda with React Router

`@bounda-dev/react-router` integrates through a Vite plugin. Bounda's `app/domain` and `app/read`
live next to `app/routes`; the generator ignores the rest.

```ts
// vite.config.ts
import { bounda } from "@bounda-dev/react-router/vite";
import { reactRouter } from "@react-router/dev/vite";
export default defineConfig({ plugins: [bounda(), reactRouter()] });

// app/root.tsx
import { boundaMiddleware } from "@bounda-dev/react-router/app";
export const middleware: Route.MiddlewareFunction[] = [boundaMiddleware];

// a route: actions dispatch, loaders query
import { bounda } from "@bounda-dev/react-router/app";
import { failure } from "../errors.server";
export const action = async ({ request, context }: Route.ActionArgs) => {
  const form = await request.formData();
  try {
    await context.get(bounda).commands.registerUser({
      userId: crypto.randomUUID(),
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
    });
  } catch (error) {
    return failure(error);
  }
  return redirect("/users");
};
export const loader = ({ context }: Route.LoaderArgs) => context.get(bounda).queries.listUsers({});
```

- The plugin runs `bounda generate` on start and on every change under `app/domain` and
  `app/read`; do not run `bounda generate --watch` alongside it. Keep `bounda generate` as a script
  for CI, because `react-router typegen && tsc` needs the generated files first.
- `@bounda-dev/react-router/app` is server-only: loaders, actions, middleware. Never in components.
- The app in the context reads its own writes by default (`bounda({ consistency: "immediate" })`):
  a page reached right after a command sees its read models. Never call `processUntilIdle()` in a
  route.
- Map `ValidationError` to a 400 with `error.issues` and `DomainError` to a 409 in one helper
  (`failure`); let anything else reach the `ErrorBoundary`.
- Typecheck with `react-router typegen && tsc`; `.react-router/types` holds the route types and
  Bounda's `+types` sit next to the modules. They do not clash.

## Working in a Bounda repo

- After changing the layout: `bounda generate`, then type-check. Convention problems exit with
  code 1 and name the file; fix the name or the location.
- Tests: `createTestApp({ registry, adapter? })` from `@bounda-dev/core/testing` gives an app on the
  in-memory adapter with a fixed clock (`clock.advance(ms)`) and sequential ids; call
  `await app.processUntilIdle()` after dispatching to run policies, processes and projections.
  The clock drives handler time-outs and background polling too: never wait real time in a test,
  advance the clock.
  `import { registry } from "../.bounda/registry.ts"`.
- `boot()` from `@bounda-dev/core/node` is typed for the project without a type argument:
  `.bounda/register.d.ts` registers the registry type with `@bounda-dev/core/register`. Never write
  `boot<typeof registry>()`.
- New project: `npm create bounda@latest <dir> -- --database sqlite|postgresql --framework node|react-router`
  (`--yes` takes the defaults: SQLite, Node), or `-- --framework cloudflare` for a Worker with a
  Durable Object per tenant (no `--database`: the store is the object's SQLite).
- On Cloudflare: `storage: cloudflare()`, `createBoundaObject({ registry, config })` exported
  from the Worker and bound in `wrangler.jsonc` with a `new_sqlite_classes` migration. Commands
  update read models before answering; policies, processes and scheduled work run in the object's
  alarm, which it arms itself. Talk to a store with `connect(stub)`, typed like `app.commands`;
  `createWorker` is an unauthenticated JSON starting point.
- Storage: `sqlite({ path })`, `sqlite({ memory: true })` or `postgresql({ url })` in
  `bounda.config.ts`; read models can point at a different adapter with `readModels`.
- A store is one ordered log with one writer at a time; projections, policies and processes read
  it by checkpoint. A policy or process reacts only to events stored after it is deployed, never
  to earlier history; an app without policies or processes runs no runner for them. Do not try to scale by splitting the log or adding a broker inside the app:
  the way out is one store per tenant (`postgresql({ schema })`). Events that must reach other
  systems go through a publisher subscriber, not built yet.
- With PostgreSQL the dispatcher is woken by `NOTIFY` on every append and polls only every
  `runtime.dispatcher.idleInterval` (30 s) as a safety net; with SQLite it polls at
  `runtime.dispatcher.pollInterval` (100 ms). Do not add a queue or a broker to make policies
  react faster.
- Observability is OpenTelemetry through `@opentelemetry/api`, which `core` depends on. Register
  an SDK before `boot()` and the runtime's spans (`bounda.command`, `bounda.subscriber`,
  `bounda.projection`, `bounda.policy`, `bounda.process`, `bounda.scheduled`) and metrics
  (`bounda.dispatcher.lag`, `bounda.commands`, `bounda.dead_letters`) appear; without one, nothing
  happens. Do not add a logging or tracing abstraction of your own.
- Never change the shape of an event's `payload` in place once events are stored. Add
  `<event>.upcast.ts` next to it exporting `upcasts`, an array of functions oldest first, each
  turning version n's payload into version n+1's, the last returning today's payload
  (`satisfies Event.Upcasts` from the event's `+types`). The runtime applies them on read. A new
  optional field needs no upcaster; a field that cannot be derived needs a new event type instead.
- A policy or process handler that failed for good, or a scheduled command that was dropped, is
  a dead letter: `bounda dead-letters list`, then `replay <id>` after fixing the cause or
  `discard <id>`. In code, `app.deadLetters`. Nothing re-runs a dead letter on its own. Events
  that reach a failed process instance are parked in its stream (`ProcessEventParked`), in order;
  replaying the failure handles them, then the instance resumes (`ProcessResumed`) and its
  deadlines are scheduled again. A letter's `parked` says how many wait behind it; discarding the
  letter gives the instance up.
- A view may gain fields freely. Removing a field, changing its type, or fixing a projection that
  wrote wrong rows means `bounda rebuild <read-model>`: it projects the stream into a fresh table
  and swaps it in; an interrupted rebuild resumes on the next run, and on Cloudflare the object's
  alarm runs it in slices. Never rename a read model to get a rebuild, and never write
  projections through `client` with hand-written SQL, since a rebuild cannot redirect that.
