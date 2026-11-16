import type { EventPayloadArgs, PayloadArgs, Registry } from "@bounda-dev/core";

// A member whose tax id a legal obligation keeps: forgetting the tenant needs to be told so.
export const registry = {
  aggregates: {
    member: {
      events: {
        joined: {
          payload: ({ z, personal }: EventPayloadArgs) =>
            z.object({ taxId: personal(z.string(), { category: "invoices" as never }) }),
          evolve: ({ state }: { state: object }) => state,
        },
      },
      commands: {
        join: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ memberId: z.string(), taxId: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { taxId: string } };
              events: { joined: (payload: { taxId: string }) => unknown };
            }) => [events.joined({ taxId: command.payload.taxId })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
  personalData: {
    categories: { invoices: { basis: "legal-obligation", retention: "6y" } },
  },
} as unknown as Registry;
