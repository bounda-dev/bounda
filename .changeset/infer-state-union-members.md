---
"@bounda-dev/cli": patch
---

State inference lists a member once when more than one event gives it to a field: a `begin` that
sets `chargeId: null as string | null` and an `evolve` that sets a `string` type it as
`string | null`, no longer `string | string | null`. `boolean` and enums stay whole. A function
type one event gives a field next to another event's type keeps its parentheses,
`(() => void) | null`, where it came out as `() => void | null`, a function that returns
`void | null`; an intersection takes them too.
