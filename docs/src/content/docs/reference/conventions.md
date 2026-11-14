---
title: Conventions and generated files
description: Every file the generator reads, what it must export, what it refuses or warns about, and what it writes.
sidebar:
  order: 2
---

`bounda generate` reads `app/domain` and `app/read` by file and directory names, and looks for
`app/audit.ts`; it imports no module. This page is the contract in one place. [Project layout](/guides/project-layout/) and
[Read models](/guides/read-models/) explain each kind of module with an example, and
[Names](/guides/project-layout/#names) how a file name becomes the key and the type your code sees.

## Files and what they export

Names are kebab-case. `<x>` is a name you choose.

| Path | Exports |
| --- | --- |
| `app/domain/<aggregate>/state.ts` | optional: `initialState`, and `aggregateId` (the payload field holding the id) |
| `app/domain/<aggregate>/<event>.ts` | `payload` (optional), and `begin` for the event that opens the aggregate or `evolve`, or both; nothing else at run time |
| `app/domain/<aggregate>/<event>.upcast.ts` | `upcasts`, oldest version first, next to its event |
| `app/domain/<aggregate>/<port>.ts` | `interface <Port>`, named after the file; it is a port because `infrastructure/<port>/` exists |
| `app/domain/<aggregate>/infrastructure/<port>/<implementation>.ts` | `export default ... satisfies <Port>`, or `create`, typed as `CreateImplementation<Port>` |
| `app/domain/<aggregate>/commands/<command>.ts` | `payload` (optional), `rejections` (optional), `handler` |
| `app/domain/<aggregate>/policies/<action>-on-<event>.ts` | `handler`; `on`, `delay` and `restricted`, the [basis it processes restricted data on](/guides/personal-data/#processing-restricted-data-anyway), optional |
| `app/domain/<aggregate>/policies/<other-aggregate>/<action>-on-<event>.ts` | the same, for that aggregate's events; `bounda` for the runtime's own: `PersonalDataForgotten`, `ProcessingRestricted`, `ProcessingRestrictionLiftAnnounced`, `ProcessingRestrictionLifted` |
| `app/domain/<aggregate>/processes/<process>/index.ts` | `config` (`startedBy`, `completedBy`, `timeout`), `state` (optional), `correlate` (optional), `restricted` (optional, the [basis it processes restricted data on](/guides/personal-data/#processing-restricted-data-anyway)) |
| `app/domain/<aggregate>/processes/<process>/on-<event>.ts` | `handler` |
| `app/domain/<aggregate>/processes/<process>/at-<deadline>.ts`, `at-timeout.ts` | `handler` |
| `app/domain/<aggregate>/processes/<process>/<other-aggregate>/on-<event>.ts` | `handler`, for that aggregate's event |
| `app/audit.ts` | optional: `onPersonalDataAccess`, typed as `OnPersonalDataAccess`, where the [access log](/guides/personal-data/#who-opened-what) goes; without it, the app's logger |
| `app/personal-data.ts` | optional: `categories`, `satisfies PersonalData.Categories`, the [categories of personal data](/guides/personal-data/#categories) with their basis and retention; without it, every personal field is in the default category |
| `app/read/<read-model>/view.ts` | `fields`; `.person()` on at most one field, `.personal()` on those that hold that person's data; `holdsPersonalData = false` (optional) to state it keeps nothing of anyone's data though it projects events with personal fields |
| `app/read/<read-model>/projections/<aggregate>/<event>.ts` | `project`; `on` optional |
| `app/read/<read-model>/projections/bounda/personal-data-forgotten.ts` | `project`, required once its view keeps a field in the clear with `.personal({ clear: true })`, or a projection of the read model sees a field marked `personal` and the view marks no field `.personal()` |
| `app/read/<read-model>/projections/bounda/processing-restricted.ts`, `processing-restriction-lift-announced.ts`, `processing-restriction-lifted.ts` | `project`, optional |
| `app/read/<read-model>/queries/<query>.ts` | `payload` (optional), `repository` (optional), `handler` |
| `app/read/<read-model>/<port>.ts`, `infrastructure/<port>/<implementation>.ts` | as in an aggregate; only the queries' `handler` receives them |

Any other module or directory at the root of an aggregate or a read model is yours: a value
object, a domain service, a helper the handlers import. The generator leaves it alone, and so it
does files that start with `_` or `.`, tests (`*.test.ts`, `*.test-d.ts`), declarations
(`*.d.ts`) and `+types` directories.

## What the generator refuses

`bounda generate` fails, naming the file and saying what to do, for:

- a name that is not kebab-case, or a file that is not a `.ts` module where modules go;
- a command or a policy that is a directory, a process that is a file, a process directory without
  `index.ts`, a read model without `view.ts`, a projection or a query that is a directory;
- a projection outside a folder named after an aggregate of the app, or after `bounda` with a
  name that is no event of the runtime's; an aggregate named `bounda`;
- a process handler not named `on-<event>.ts` or `at-<deadline>.ts`, or one for an event its
  aggregate does not have;
- a module at an aggregate's root that exports an event's function (`payload`, `begin`, `evolve`)
  and something else besides, and an `<event>.upcast.ts` with no event next to it;
- a port whose module does not export an interface or a type alias named after it, a port
  directory with no implementation or with subdirectories, an implementation with no port, and a
  port named after an event of its aggregate or after a reserved name: `command`, `state`,
  `events`, `event`, `commands`, `idempotencyKey`, `signal`, `aggregateId`, `after`, `reject`,
  `forget` in an aggregate, and `view`, `query`, `repositoryData`, `table`, `queries`, `actor` in
  a read model;
- a policy and a process of one aggregate with the same key (`policies/checkout.ts` next to
  `processes/checkout/`, or `policies/payment-refund-on-payment-failed.ts` next to
  `policies/payment/refund-on-payment-failed.ts`), a policy named after an aggregate, a policy
  folder named after the aggregate it is in, and a read model named like an aggregate;
- two commands, or two queries, with the same key anywhere in the app: `app.commands` and
  `app.queries` are one namespace each;
- an aggregate or a read model whose generated types would meet others in `.bounda/types.ts`: one
  named `test` (`TestPorts` is Bounda's own), or `order-created` next to `order`.

Some rules are checked by the compiler rather than the generator, at the `<ReadModel>Forgetting`
type of `.bounda/types.ts`, which says what to add: a read model that keeps a field in the clear
with `.personal({ clear: true })`, or projects an event with a field marked `personal` and marks no
field `.personal()`, and has no `projections/bounda/personal-data-forgotten.ts`; one that marks a
field `.personal()` and none
`.person()`; one that projects an event with a field marked `personal` and marks no field
`.person()` without its view exporting `holdsPersonalData = false`, or one that exports it and marks
a field; one that marks two fields `.person()`. The app refuses to start on the same rules, with
`ConfigurationError`. The generated registry is checked against
`Registry`, so an `app/audit.ts` whose `onPersonalDataAccess` is not an `OnPersonalDataAccess`
fails to compile there. `PersonalDataDeclaration` fails to compile while `app/personal-data.ts`
declares a category named `default`, or one without a basis Bounda knows or a retention, and a
category that `personal({ category })`, `.personal({ category })` or `forget` names and the file
does not declare does not compile where it is written. See
[Personal data in read models](/guides/personal-data/#personal-data-in-read-models).

## What boot refuses

Some rules need the modules themselves, so the app checks them when it is created and throws a
`ConfigurationError`:

- a policy or a projection whose trigger is not an event of the aggregate it listens to, the
  runtime's own `bounda` included; an event, a command or a process `state` that marks two fields
  with `person`, and a process `state` that starts with a `personal` or `person` field set;
- a `deadline()` field without its `at-` file, and an `at-` file without its field; the name
  `timeout` is reserved for the process's lifetime;
- an event of another aggregate that a process listens to and cannot assign to an instance, by an
  id field in its payload or by `correlate`;
- a policy and a process that share a key;
- a read model that marks two fields `.person()`, marks a field `.personal()` and none
  `.person()`, or keeps a field in the clear with `.personal({ clear: true })` and does not project
  `PersonalDataForgotten`; one that seals its primary key, or names a field like the columns the
  runtime keeps beside personal ones, ending in `__key` or `__index`;
- an `app/audit.ts` that does not export `onPersonalDataAccess` as a function;
- an `app/personal-data.ts` whose `categories` is not an object, declares `default`, names a
  category with anything but letters, digits, `-` and `_` after a first letter, or gives one a
  basis article 6 does not name or a retention that is not a duration longer than none; a field
  marked personal in a category the file does not declare;
- a `payload`, `repository`, process `state` or `correlate` export that is not a function;
- a configuration that names a port, an implementation, an aggregate or a read model that does
  not exist, or leaves out a port that has several implementations.

## What the generator warns about

Mistakes that leave the layout valid but would leave a module unregistered are warnings, printed
and not failed on:

- a module at an aggregate's root that imports its own `+types` without exporting `payload`,
  `begin` or `evolve`: an event that lost the export that made it one (a leftover `apply`, a typo
  in `evolve`);
- a directory one letter away from `commands`, `policies`, `processes` or `infrastructure`, or
  named `command`, `policy`, `process` or `infra`;
- in a read model, a directory one letter away from `projections`, `queries` or
  `infrastructure`, or named `projection`, `query` or `infra`, and a module at its root that
  exports `project`, `repository` or `handler`;
- a policy or a projection that exports no `on` and whose name gives no event of its aggregate,
  which boot refuses: most likely a misspelt event.

## Generated files

`bounda generate` writes:

| Path | Holds |
| --- | --- |
| `.bounda/registry.ts` | Every module, grouped as the runtime needs it, and `app/audit.ts` as `audit` and `app/personal-data.ts` as `personalData` when there are. `boot()` imports it |
| `.bounda/register.d.ts` | Registers the registry type, the type of the `ports` section and the names of the categories of personal data with `@bounda-dev/core/register`, so `boot()` and `BoundaApp` are typed for the project without a type argument, `defineConfig` checks the implementation names, and `personal({ category })` and `forget` check the categories |
| `.bounda/types.ts` | The state, events, ports, commands, rows and queries maps the `+types` build on, how each read model stores its fields (`<ReadModel>FieldTypes`, which decides what its table filters each field by), one `<ReadModel>Forgetting` check per read model, `PersonalCategory`, the names `app/personal-data.ts` declares, and its `PersonalDataDeclaration` check |
| `**/+types/<name>.ts` | The argument types each module imports. An implementation has none: it imports its port |

They are derived from your code, so they are not versioned. `tsconfig.json` must include them as
`.bounda/**/*` (TypeScript skips a bare `.bounda` entry because the directory starts with a dot);
`create-bounda` sets this up. Add to `.gitignore`:

```
.bounda/
**/+types/
```

and run the generator before anything type-checks, typically as `prepare` in `package.json`:

```json
{ "scripts": { "prepare": "bounda generate", "dev": "bounda generate --watch" } }
```

If your formatter or linter picks up generated files, exclude the same two patterns; their layout
is fixed by the generator. [`bounda generate`](/reference/cli/) has the command's options.
