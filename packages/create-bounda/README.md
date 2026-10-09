<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.bounda.dev/wordmark-dark.svg" />
    <img src="https://docs.bounda.dev/wordmark-light.svg" alt="Bounda" width="160" />
  </picture>
</p>

# create-bounda

[![Mutation score](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2Fbounda-dev%2Fbounda%2Fmain%3Fmodule%3Dcreate-bounda)](https://dashboard.stryker-mutator.io/reports/github.com/bounda-dev/bounda/main?module=create-bounda)

Scaffolds a [Bounda](https://docs.bounda.dev) project: one aggregate, one read model, a test and
the generator wired up.

```bash
npm create bounda@latest my-app
```

It asks where the app runs, which framework it uses and, on Node, which database, or takes the
answers as flags:

```bash
npm create bounda@latest my-app -- --runtime node --framework react-router --database postgresql
```

| Flag | Values | Default |
| --- | --- | --- |
| `--runtime` | `node`, `cloudflare` | `node`, or asked |
| `--framework` | `none`, `react-router` | `none`, or asked |
| `--database` | `sqlite`, `postgresql`, on `node` only | `sqlite`, or asked |
| `--pm` | `pnpm`, `npm`, `yarn`, `bun` | whichever ran the command |
| `--no-install`, `--no-git`, `--yes` | | |

On `node`, `none` gives a script that boots the app and places an order, and `react-router` a
React Router 8 app in framework mode with a page that dispatches a command from an action and
reads a query from a loader. On `cloudflare` the store is a Durable Object per tenant, so there
is no database to pick: `none` gives a Worker with a JSON API, and `react-router` the same React
Router app, served from the Worker.

Installing runs the generator (the `prepare` script on Node; on Cloudflare, `create-bounda` runs
`generate` itself), so the project type-checks and its test passes straight away.

## Status

0.x. Until 1.0 the API can still change between minor versions, and every change that breaks
something is called out in the changelog.

Docs: [docs.bounda.dev/getting-started](https://docs.bounda.dev/getting-started/). Source and
issues: [github.com/bounda-dev/bounda](https://github.com/bounda-dev/bounda).
