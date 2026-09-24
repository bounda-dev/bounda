# Changesets

Every pull request that changes a published package adds a changeset:

```bash
pnpm changeset
```

All `@bounda-dev/*` packages and `create-bounda` are versioned together (`fixed` group) and published under the `latest` dist-tag. Until 1.0, a change that breaks something is a `minor` changeset and anything else is a `patch`; a `major` would jump to 1.0. For a series of prereleases, `pnpm changeset pre enter <tag>` starts one and `pnpm changeset pre exit` ends it. Releases are cut by the `release.yml` workflow on `main` using npm trusted publishing; no token is stored in the repository. The workflow only runs while the repository variable `RELEASE_ENABLED` is `true`.
