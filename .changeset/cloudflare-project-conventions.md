---
"create-bounda": patch
---

A Cloudflare project follows Cloudflare's own conventions. Its tests run inside workerd with `@cloudflare/vitest-plugin`, and a new `tests/api.test.ts` reaches the real Durable Object through `SELF.fetch`; since the plugin supports Vitest 4.1, the project pins that version. Binding types come from `wrangler types` instead of `@cloudflare/workers-types`, which `dev`, `typecheck` and a new `check` script run. There is no `prepare` script, so `npm install --package-lock-only` works, and `wrangler.jsonc` uploads source maps.
