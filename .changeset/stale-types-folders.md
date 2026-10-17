---
"@bounda-dev/cli": patch
---

`bounda generate` no longer takes a folder that holds nothing but `+types` for an aggregate or a
read model. Deleting or renaming one left its generated `+types` behind, and the next run failed
with "a read model needs a view.ts with its fields" before it could clean them up. Such a folder is
now ignored, its `+types` files are removed, and so is every folder the removal leaves empty.
