/// <reference lib="esnext.disposable" />
import {
  type CreateArgs,
  DomainError,
  type FieldsArgs,
  type Instant,
  type PayloadArgs,
  type ProcessAfterFunction,
  type ProcessStateArgs,
  type Registry,
  type RejectFunction,
  type Rejection,
  type Table,
  ValidationError,
} from "@bounda-dev/core";

interface OrderState {
  readonly status: "new" | "placed" | "paid" | "archived";
}

interface OrderRow {
  readonly orderId: string;
  readonly status: string;
  readonly total: number;
}

interface CustomerRow {
  readonly customer: string;
  readonly lastOrderId: string;
}

type Events = Record<string, (payload?: unknown) => unknown>;

/**
 * Outages the tests switch on and off. While `archive` is down, the policy refuses an order whose
 * id starts with "fail" as invalid, which dead-letters it at once; while `projection` is down, the
 * read model fails to project a placed order.
 */
export const outage = { archive: true, projection: false };

/**
 * A small order app: place, pay and archive, a note whose handler lets another app's rejection
 * through, a policy that archives paid orders, fails for an order whose id starts with "fail"
 * while the archive is down and times out for one whose id starts with "flaky", which it retries,
 * and a read model with one query.
 */
export const registry = {
  aggregates: {
    order: {
      state: { initialState: { status: "new" } satisfies OrderState },
      events: {
        orderPlaced: {
          payload: ({ z }: PayloadArgs) => z.object({ total: z.number(), customer: z.string() }),
          evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "placed" as const }),
        },
        orderPaid: {
          evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "paid" as const }),
        },
        orderArchived: {
          evolve: ({ state }: { state: OrderState }) => ({ ...state, status: "archived" as const }),
        },
      },
      commands: {
        placeOrder: {
          module: {
            payload: ({ z }: PayloadArgs) =>
              z.object({ orderId: z.string(), total: z.number(), customer: z.string() }),
            rejections: () => ({ AlreadyPlaced: "Order already placed" }),
            handler: ({
              command,
              state,
              events,
              reject,
            }: {
              command: { payload: { total: number; customer: string } };
              state: OrderState;
              events: Events;
              reject: RejectFunction<"AlreadyPlaced">;
            }) => {
              if (state.status !== "new") return reject("AlreadyPlaced");
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
            rejections: () => ({ NotPlaced: "Only placed orders can be paid" }),
            handler: ({
              state,
              events,
              reject,
            }: {
              state: OrderState;
              events: Events;
              reject: RejectFunction<"NotPlaced">;
            }) => {
              if (state.status !== "placed") return reject("NotPlaced");
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
        noteOrder: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ orderId: z.string() }),
            handler: () => {
              throw new DomainError({
                code: "Elsewhere",
                message: "Another app said no",
              } as Rejection);
            },
          },
        },
      },
      policies: {
        archiveOnOrderPaid: {
          module: {
            handler: async ({
              event,
              commands,
            }: {
              event: { aggregateId: string };
              commands: { archiveOrder: (payload: { orderId: string }) => Promise<unknown> };
            }) => {
              if (event.aggregateId.startsWith("fail") && outage.archive)
                throw new ValidationError("archive is down", []);
              if (event.aggregateId.startsWith("flaky")) throw new Error("archive timed out");
              await commands.archiveOrder({ orderId: event.aggregateId });
            },
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
        order: {
          orderPlaced: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { total: number } };
              table: Table<OrderRow>;
            }) => {
              if (outage.projection) throw new Error("projection is down");
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

interface SettlementState {
  readonly remind: Instant | null;
}

/**
 * The order app with a process besides its policy: started by the order, it pays it at a
 * reminder an hour later and completes once the policy has archived it.
 */
export const processRegistry = {
  ...registry,
  aggregates: {
    order: {
      ...registry.aggregates.order,
      processes: {
        settlement: {
          module: {
            config: ({
              events,
            }: {
              events: { order: { OrderPlaced: string; OrderArchived: string } };
            }) => ({
              startedBy: [events.order.OrderPlaced],
              completedBy: [events.order.OrderArchived],
              timeout: "2h",
            }),
            state: ({ z, deadline }: ProcessStateArgs) => z.object({ remind: deadline() }),
          },
          handlers: {
            order: {
              orderPlaced: {
                handler: ({
                  state,
                  after,
                }: {
                  state: SettlementState;
                  after: ProcessAfterFunction;
                }) => ({ ...state, remind: after("1h") }),
              },
            },
          },
          deadlines: {
            remind: {
              handler: async ({
                state,
                aggregateId,
                commands,
              }: {
                state: SettlementState;
                aggregateId: string;
                commands: { payOrder: (payload: { orderId: string }) => Promise<unknown> };
              }) => {
                await commands.payOrder({ orderId: aggregateId });
                return { ...state, remind: null };
              },
            },
          },
        },
      },
    },
  },
} satisfies Registry;

/**
 * The order app without its policy or processes: commands and a read model only.
 */
export const quietRegistry = {
  ...registry,
  aggregates: { order: { ...registry.aggregates.order, policies: {}, processes: {} } },
} satisfies Registry;

/**
 * The order app without policies or processes, with a second read model, of customers, which the
 * projection outage leaves alone.
 */
export const slicedRegistry = {
  ...quietRegistry,
  readModels: {
    ...quietRegistry.readModels,
    customers: {
      view: {
        fields: ({ f }: FieldsArgs) => ({
          customer: f.string().primaryKey(),
          lastOrderId: f.string(),
        }),
      },
      projections: {
        order: {
          orderPlaced: {
            project: async ({
              event,
              table,
            }: {
              event: { aggregateId: string; payload: { customer: string } };
              table: Table<CustomerRow>;
            }) => {
              await table.upsert({
                customer: event.payload.customer,
                lastOrderId: event.aggregateId,
              });
            },
          },
        },
      },
      queries: {},
    },
  },
} satisfies Registry;

const placeOrder = quietRegistry.aggregates.order.commands.placeOrder.module.handler;

/**
 * What the `region` port saw: the orders it recorded, prefixed with the binding and the tenant its
 * `create` read, and when it was closed.
 */
export const regionLog: string[] = [];

/**
 * The order app with an implementation built by `create` from a variable of the Worker's `env`.
 */
export const regionRegistry = {
  ...quietRegistry,
  aggregates: {
    order: {
      ...quietRegistry.aggregates.order,
      ports: {
        region: {
          binding: {
            create: ({ env, tenant = "unnamed" }: CreateArgs) => ({
              record: (orderId: string) =>
                regionLog.push(`${env.STORE_REGION}:${tenant}:${orderId}`),
              [Symbol.asyncDispose]: async () => void regionLog.push("closed"),
            }),
          },
        },
      },
      commands: {
        ...quietRegistry.aggregates.order.commands,
        placeOrder: {
          module: {
            ...quietRegistry.aggregates.order.commands.placeOrder.module,
            handler: (
              args: Parameters<typeof placeOrder>[0] & {
                command: { aggregateId: string };
                region: { record: (orderId: string) => void };
              },
            ) => {
              args.region.record(args.command.aggregateId);
              return placeOrder(args);
            },
          },
        },
      },
    },
  },
} satisfies Registry;
