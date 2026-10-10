---
"create-bounda": minor
---

`create-bounda` asks where the app runs, which framework it uses and, on Node, which database,
and scaffolds every combination: Node or Cloudflare, each with or without React Router. React
Router on Cloudflare is new: React Router in the Worker, through `@cloudflare/vite-plugin`, and
the store in a Durable Object per tenant, which `app/tenant.ts` names, `"default"` for every
request until you change it.

Breaking:

- `--runtime node|cloudflare` takes Cloudflare out of `--framework`, which is now
  `none|react-router`: `--framework cloudflare` is `--runtime cloudflare`, and `--framework node`
  is `--framework none`.
- `--database` applies to Node only. Given without `--runtime`, it means Node instead of asking.

Also:

- Each project's README spells its commands for the package manager that created it, so bun users
  read `bun run test` rather than `bun test`, which is bun's own test runner. Its links go to
  `docs.bounda.dev`, and it says `begin` where it said `create`.
- On Windows, nested files land in their place instead of under a doubled path.
- The Node script no longer creates `./data`: the SQLite adapter does, and PostgreSQL never needed
  it.
- Cloudflare projects get `wrangler` 4.149 and `@cloudflare/vitest-plugin` 1.4.
