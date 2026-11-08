import type { CreateArgs, FieldsArgs, Registry } from "@bounda-dev/core";
import { registry as base } from "./registry.ts";

// The fixture's registry with a read model whose projection quotes what it read as it fails,
// and a port that logs an error quoting it as it is built.
export const registry = {
  ...base,
  aggregates: {
    ...base.aggregates,
    counter: {
      ...base.aggregates.counter,
      ports: {
        probe: {
          noisy: {
            create: ({ logger }: CreateArgs) => {
              logger.warn("probe", { cause: new Error("probed ana@example.com") });
              return {};
            },
          },
        },
      },
    },
  },
  readModels: {
    ...base.readModels,
    failingTotals: {
      view: { fields: ({ f }: FieldsArgs) => ({ counterId: f.string().primaryKey() }) },
      projections: {
        counter: {
          incremented: {
            project: () => {
              throw new Error("cannot total ana@example.com");
            },
          },
        },
      },
      queries: {},
    },
  },
} as const satisfies Registry;
