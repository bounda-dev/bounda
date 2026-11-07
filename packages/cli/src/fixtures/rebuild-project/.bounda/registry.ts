import {
  type EventPayloadArgs,
  type FieldsArgs,
  type PayloadArgs,
  type Registry,
  ValidationError,
} from "@bounda-dev/core";

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
    member: {
      events: {
        joined: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        join: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ memberId: z.string(), name: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: { joined: (payload: { name: string }) => unknown };
            }) => [events.joined({ name: command.payload.name })],
          },
        },
      },
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
