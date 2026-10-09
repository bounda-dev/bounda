---
name: bounda
description: Build event-sourced TypeScript apps with Bounda. Use when working in a project that has a bounda.config.ts, when the user mentions aggregates, commands, events, policies, processes, projections or read models in a Bounda codebase, or asks to add a feature to a Bounda app.
---

# Bounda

Bounda is an event sourcing and CQRS framework for TypeScript. An app is a tree of small modules
under `app/`; each file is one concept and exports the functions that concept needs.

## The two rules

1. **The file name and its folder are the declaration.** `app/domain/order/order-placed.ts` is the
   event `OrderPlaced` of the aggregate `order`. Names are kebab-case.
2. **Types come from `./+types/<file-name>`.** Every module imports `type { X } from "./+types/<same name>"`
   and annotates its exports with `X.<Something>Args`. Run `bounda generate` after adding,
   renaming or deleting a module. Never edit `.bounda/` or a `+types/` directory.

## The docs

Read the docs before writing a module; do not guess the API. They ship with the installed version
in `node_modules/@bounda-dev/core/docs/`: start at `README.md`, the index, then
`getting-started/core-concepts.md`, and `reference/conventions.md` for what every kind of file
exports; `guides/project-layout.md` and `guides/read-models.md` show each one with an example.
Versions before that directory existed have no copy there: read https://docs.bounda.dev
(https://docs.bounda.dev/llms.txt), which follows the latest code, and check what it shows
against the installed package's types.
