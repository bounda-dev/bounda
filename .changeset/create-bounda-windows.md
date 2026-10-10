---
"create-bounda": patch
---

On Windows, `create-bounda` installs the dependencies and generates the types instead of warning
that the install failed: npm, pnpm and yarn are `.cmd` shims there, which it now runs through the
shell.
