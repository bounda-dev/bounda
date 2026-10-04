---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

What a process handler returns is merged over its state, as `Partial<State>` already promised. A
handler returned `{ paymentDeadline: null }` and the runtime parsed it as the whole state, so every
field it left out went back to its default without a word: a `paymentId` set earlier became `null`
and the compensation that needed it did nothing. A handler now returns only the fields that change,
or nothing to keep the state. The merge is shallow, so a nested object is replaced whole, and a
field goes back to its default only when the handler sets it; one returned as `undefined` keeps its
value. A handler that returns anything but an object or nothing fails the process, a deadline
handler's `null` and a process without `state` included. The `ReturnCheck` of an `at-<field>.ts`
requires its field, as `null` or another moment, so leaving it out no longer compiles;
`ProcessDeadlineResult` is the type it checks against.
