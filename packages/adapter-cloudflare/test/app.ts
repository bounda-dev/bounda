import {
  DomainError,
  type FieldsArgs,
  type PayloadArgs,
  type Registry,
  type Table,
} from "@bounda-dev/core";

interface OrderState {
  readonly status: "new" | "placed" | "paid" | "archived";
}

interface OrderRow {
  readonly orderId: string;
  readonly status: string;
  readonly total: number;
}

type Events = Record<string, (payload?: unknown) => unknown>;

/**
 * A small order app: place, pay and archive, a policy that archives paid orders and fails for a
 * customer called "fail", and a read model with one query.
 */
export const registry = {
  aggregates: {
    order: {
      state: { initialState: { status: "new" } satisfies OrderState },
      events: {
        orderPlaced: {
          payload: ({ z }: PayloadArgs) => z.object({ total: z.number(), customer: z.string() }),
          apply: ({ state }: { state: OrderState }) => ({ ...state, status: "placed" as const }),
        },
        orderPaid: {
          apply: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
        },
        orderArchived: {
          apply: ({ state }: { state: OrderState }) => ({ ...state, status: "archived" as const }),
        },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ orderId: z.string(), total: z.number(), customer: z.string() }),
            handler: ({
              command,
              state,
              events,
            }: {
              command: { payload: { total: number; customer: string } };
              state: OrderState;
              events: Events;
            }) => {
              if (state.status !== "new") throw new DomainError("Order already placed");
              return [
                events.orderPlaced?.({
                  total: command.payload.total,
                  customer: command.payload.customer,
                }),
              ];
            },
          },
        },
        payOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            handler: ({ state, events }: { state: OrderState; events: Events }) => {
              if (state.status !== "placed")
                throw new DomainError("Only placed orders can be paid");
              return [events.orderPaid?.()];
            },
          },
        },
        archiveOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            handler: ({ events }: { events: Events }) => [events.orderArchived?.()],
          },
        },
      },
      policies: {
        archiveOnOrderPaid: {
          handler: async ({
            event,
            commands,
          }: {
            event: { aggregateId: string };
            commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
          }) => {
            if (event.aggregateId.startsWith("fail")) throw new DomainError("archive is down");
            await commands.archiveOrder({ orderId: event.aggregateId });
          },
        },
      },
      processes: {},
    },
  },
  readModels: {
    orders: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          orderId: f.string().primaryKey(),
          status: f.string(),
          total: f.number(),
        }),
      },
      projections: {
        orderPlaced: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string; payload: { total: number } };
            table: Table<OrderRow>;
          }) => {
            await table.upsert({
              orderId: event.aggregateId,
              status: "placed",
              total: event.payload.total,
            });
          },
        },
        orderPaid: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string };
            table: Table<OrderRow>;
          }) => {
            await table.update({ orderId: event.aggregateId }, { status: "paid" });
          },
        },
        orderArchived: {
          project: async ({
            event,
            table,
          }: {
            event: { aggregateId: string };
            table: Table<OrderRow>;
          }) => {
            await table.update({ orderId: event.aggregateId }, { status: "archived" });
          },
        },
      },
      queries: {
        getOrder: {
          payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
          handler: ({
            query,
            table,
          }: {
            query: { payload: { orderId: string } };
            table: Table<OrderRow>;
          }) => table.findOne({ orderId: query.payload.orderId }),
        },
      },
    },
  },
} satisfies Registry;
