---
"@bounda-dev/cli": patch
---

State inference types a field an `evolve` computes from the state, such as
`reminders: state.reminders + 1` or `waiting: [...state.waiting, id]`, from what the other events
set: it used to come out as `any`, without a warning. A field that only ever comes from itself, with
nothing to give it a type, or a chain of them that does not settle after a few passes, is typed as
`unknown`, and `bounda generate` warns about it.
