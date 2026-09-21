import type { PayloadArgs } from "../../../../modules/payload.ts";
import type { Registry } from "../../../../modules/registry.ts";

interface State {
  readonly count: number;
}

export const registry = {
  aggregates: {
    counter: {
      state: { initialState: { count: 0 } satisfies State },
      events: {
        incremented: {
          apply: ({ state }: { state: State }) => ({ count: state.count + 1 }),
        },
      },
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
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as const satisfies Registry;
