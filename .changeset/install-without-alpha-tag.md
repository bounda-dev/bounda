---
"@bounda-dev/core": patch
"@bounda-dev/cli": patch
"@bounda-dev/adapter-sqlite": patch
"@bounda-dev/adapter-postgresql": patch
"@bounda-dev/react-router": patch
"create-bounda": patch
---

Document installing without a dist-tag. While every published version is a prerelease, changesets
publishes to `latest`, so `npm create bounda@alpha` resolved to an older alpha than a plain
`npm create bounda`.
