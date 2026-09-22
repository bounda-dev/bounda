# @bounda-dev/cli

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcli)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=cli)

The `bounda` command line. It reads your project layout and writes the registry and every
argument type, so a Bounda app has no file to keep in sync by hand.

```bash
npm install -D @bounda-dev/cli
npx bounda generate
```

```
bounda generate [--root <dir>] [--app-dir <dir>] [--tsconfig <file>] [--no-infer] [--watch]
bounda rebuild <read-model> [--root <dir>] [--config <file>] [--registry <file>]
bounda dead-letters list [--kind <kind>] [--status <status>] [--subscriber <name>] [--limit <n>] [--json]
bounda dead-letters replay <id>
bounda dead-letters discard <id>
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

`bounda rebuild <read-model>` projects the whole stream into a fresh table and swaps it in without
taking the read model offline: for a projection that had a bug, or a view that lost a field or
changed a field's type. `bounda dead-letters` lists the handler runs that gave up and replays or
discards them.

## Alpha

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev/reference/cli](https://docs.bounda.dev/reference/cli/). Source and issues:
[github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
