---
"@bounda-dev/cli": patch
"@bounda-dev/adapter-cloudflare": minor
"@bounda-dev/core": patch
"@bounda-dev/react-router": patch
---

`bounda generate` prefixes an import of a target inside a directory whose name starts with a dot
with `./`, so importing `.bounda/registry.ts` from the project root no longer yields a bare
specifier.
`@bounda-dev/adapter-cloudflare` no longer exports `ConfigForObjectFunction`, the type of a
function it never exported. The `createBounda` example and the React Router README no longer call
a `payloadOf` helper that does not exist, and the `DomainError` JSDoc says what it does in a policy
or a process: it is terminal, and the run is dead-lettered at once.
