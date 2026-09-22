import { DomainError, type FieldsArgs, type PayloadArgs, type Registry } from "@bounda-dev/core";

export const registry = {
  aggregates: {
    counter: {
      events: { incremented: { apply: ({ state }: { state: object }) => state } },
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
          handler: () => {
            throw new DomainError("alerts are down");
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
