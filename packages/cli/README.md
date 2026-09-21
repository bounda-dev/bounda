# @bounda-dev/cli

The `bounda` command line. It reads your project layout and writes the registry and every
argument type, so a Bounda app has no file to keep in sync by hand.

```bash
npm install -D @bounda-dev/cli
npx bounda generate
```

```
bounda generate [--root <dir>] [--app-dir <dir>] [--tsconfig <file>] [--no-infer] [--watch]
```

It reads `app/domain` and `app/read` by file and directory names only, and writes
`.bounda/registry.ts`, `.bounda/register.d.ts`, `.bounda/types.ts` and one `+types/<name>.ts` next
to every module. An aggregate without `state.ts` gets its state inferred from the `apply`
functions with the TypeScript compiler. A layout that breaks a convention exits with code 1 and
names every offending file.

Keep it as `prepare` so a fresh clone generates on install, and `--watch` while you work:

```json
{ "scripts": { "prepare": "bounda generate", "dev": "bounda generate --watch" } }
```

In a React Router app the `bounda()` plugin from `@bounda-dev/react-router/vite` runs the
generator inside Vite instead.

## Alpha

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev/reference/cli](https://docs.bounda.dev/reference/cli/). Source and issues:
[github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
