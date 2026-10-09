---
"@bounda-dev/core": patch
"create-bounda": patch
---

`@bounda-dev/core` ships its documentation as plain Markdown in `docs/`, with `docs/README.md` as
the index, so an agent working in a project reads the docs of the version installed. A project
from `create-bounda` carries an `AGENTS.md` pointing there.
