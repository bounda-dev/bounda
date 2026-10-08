import { type FieldsArgs, type PayloadArgs, type Registry, ValidationError } from "@bounda-dev/core";

export const registry = {
  aggregates: {
    counter: {
      events: { incremented: { evolve: ({ state }: { state: object }) => state } },
      commands: {
        increment: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ counterId: z.string() }),
            handler: ({ events }: { events: { incremented: () => unknown } }) => [
              events.incremented(),
            ],
          },
        },
      },
      policies: {
        alertOnIncremented: {
          module: {
            handler: () => {
              throw new ValidationError("alerts are down", []);
            },
          },
        },
      },
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
