---
"@bounda-dev/core": minor
---

Hand-written SQL leaves out the rows of persons whose processing is restricted in the database itself, so a page is full and an aggregate counts only what the query may read (article 18).

- `client.unrestricted(alias?)` renders the condition for a statement's `WHERE`: the rows of no restricted person and of no key a forgetting kept, and, on the basis `includeRestricted` names, those it opens too. It binds no parameter, so it fits `?` and `$1` alike, and works in a statement through `client.raw` as well. In a projection, which reads every row, it is always true.
- Breaking: in a query of a read model with a field marked `.person()`, `client.get` and `client.all` refuse with `ConfigurationError`, before running it, a statement without `client.unrestricted()`. Before, they dropped restricted rows after the statement ran, so a `LIMIT` or `OFFSET` page came back short or empty while rows followed, `client.get` answered `null` though others matched, a row selecting neither the person nor a personal field was handed out, and `COUNT` or `SUM` counted restricted rows. A row a statement still lets through is dropped as before.
- For adapters: `RestrictedReads.condition(view, alias?)` renders that condition, and `SqlDialect.literal(text)` writes a string literal; the in-memory adapter's `condition` throws, as its `client.get` and `client.all` do.
