---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

`createTestApp` takes `collaborators`, by aggregate and port: a double written in the test, which
the handlers receive as it is and `app.stop()` never closes, or an implementation's file name,
built as the app would build it. A test can now pass a stub that rejects or a spy without a file
per scenario, and tests no longer share state through an implementation module.

Breaking: `createTestApp` no longer accepts `config.collaborators`, and no longer picks a port's
only implementation. A port the test leaves out has no implementation, so a test never reaches a
provider it did not ask for: reading it throws a `ConfigurationError` that says what to pass. A
command rejects with it, a policy or a process sends it to its dead letter without retrying, and
from then on every `app.processUntilIdle()` throws it.

The generator emits `TestCollaborators` in `.bounda/types.ts` and registers it with
`@bounda-dev/core/register` as `testCollaborators`, which the new `AppTestCollaborators` reads,
falling back to the new `TestCollaboratorsChoice`. Run `bounda generate` to update generated
files.
