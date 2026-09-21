---
"create-bounda": minor
---

Take the tool versions written into a generated project from `create-bounda`'s own dev
dependencies, which the workspace catalog resolves, instead of a second copy kept in step by a
test. `TOOL_VERSIONS` is no longer exported: `currentVersions()` returns the same versions and is
the supported way to read them.
