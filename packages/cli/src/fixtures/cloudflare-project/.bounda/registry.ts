import type { EventPayloadArgs, FieldsArgs, Registry } from "@bounda-dev/core";

export const registry = {
  personalData: { automatedDecisions: {}, categories: { contact: { basis: "consent", retention: "730d", purposes: ["Serve the person"], sources: ["data-subject"] } } },
  aggregates: {
    customer: {
      events: {
        customerRegistered: {
          payload: ({ z, personal, notPersonal }: EventPayloadArgs) =>
            z.object({
              email: personal(z.email(), { category: "contact" }),
              plan: notPersonal(z.string()),
            }),
          begin: () => ({}),
        },
      },
      commands: {},
      policies: {},
      processes: {},
    },
  },
  readModels: {
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customerId: f.string().primaryKey().person(),
          email: f.string().personal({ category: "contact" }),
        }),
      },
      projections: {},
      queries: {},
    },
  },
} as unknown as Registry;
