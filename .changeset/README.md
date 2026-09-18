# Changesets

Every pull request that changes a published package adds a changeset:

```bash
pnpm changeset
```

All `@bounda-dev/*` packages and `create-bounda` are versioned together (`fixed` group). While in pre-release mode, versions are published under the `alpha` dist-tag. Releases are cut by the `release.yml` workflow on `main` using npm trusted publishing; no token is stored in the repository.
