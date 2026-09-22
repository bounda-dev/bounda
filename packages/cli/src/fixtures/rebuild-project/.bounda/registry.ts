import type { FieldsArgs, Registry } from "@bounda-dev/core";

export const registry = {
  aggregates: {
    counter: {
      events: { incremented: { apply: ({ state }: { state: object }) => state } },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {
    counterTotals: {
      view: { fields: ({ f }: FieldsArgs) => ({ counterId: f.string().primaryKey() }) },
      projections: {},
      queries: {},
    },
  },
} as const satisfies Registry;
