# create-bounda

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcreate-bounda)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=create-bounda)

Scaffolds a [Bounda](https://docs.bounda.dev) project: one aggregate, one read model, a test and
the generator wired up.

```bash
npm create bounda my-app
```

It asks for a database and how the app runs, or takes both as flags:

```bash
npm create bounda my-app -- --database postgresql --framework react-router
```

| Flag | Values | Default |
| --- | --- | --- |
| `--database` | `sqlite`, `postgresql` | `sqlite`, or asked |
| `--framework` | `node`, `react-router` | `node`, or asked |
| `--pm` | `pnpm`, `npm`, `yarn`, `bun` | whichever ran the command |
| `--no-install`, `--no-git`, `--yes` | | |

`node` gives a script that boots the app and places an order. `react-router` gives a React Router
8 app in framework mode with a page that dispatches a command from an action and reads a query
from a loader.

Installing runs the generator (it is the `prepare` script), so the project type-checks and its
test passes straight away.

## Alpha

Every published version is a prerelease. The API can change between alphas without a deprecation
cycle.

Docs: [docs.bounda.dev/getting-started](https://docs.bounda.dev/getting-started/). Source and
issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
