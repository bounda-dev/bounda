---
"@bounda-dev/core": minor
"@bounda-dev/cli": minor
---

A read model can have ports, as an aggregate does: `order-summary/rates.ts` exports the interface
and `order-summary/infrastructure/rates/` holds its implementations. Only its queries' `handler`
receives them, next to `query`, `repositoryData`, `table` and `queries`; `repository`, which reads
the storage, and the projections do not. A projection commits with its checkpoint in one
transaction, runs again on a rebuild and runs inside a command's request, so a call to the outside
from it would repeat, change the rows a rebuild produces, or slow every command. The root of a read
model also holds any module of the app's own, and `bounda generate` warns about a directory one
letter away from `projections`, `queries` or `infrastructure`.

`bounda.config.ts` chooses a read model's implementations in the same `ports` section, by read model
and port (`ports: { orderSummary: { rates: "ecb" } }`), and `createTestApp` takes their doubles the
same way. `.bounda/types.ts` gains `<ReadModel>Ports`, and `Query.HandlerArgs` takes it. A read
model's port cannot be called `view`, `query`, `repositoryData`, `table`, `queries` or `client`.
