import type { EventPayloadArgs, Registry } from "@bounda-dev/core";

export const registry = {
  aggregates: {
    customer: {
      events: {
        customerNoted: {
          payload: ({ z }: EventPayloadArgs) => z.object({ phone: z.string(), age: z.number() }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;
