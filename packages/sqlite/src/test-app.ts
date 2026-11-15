import {
  type BoundaApp,
  type Clock,
  createApp,
  type EventPayloadArgs,
  type Logger,
  type PayloadArgs,
  type Registry,
  systemClock,
} from "@bounda-dev/core";
import { masterKey } from "@bounda-dev/core/config";
import { sqlite } from "./index.ts";

// An app with one personal field, which tests start here and in processes of their own.

export const testRegistry = {
  aggregates: {
    customer: {
      state: { initialState: {} },
      events: {
        customerRegistered: {
          payload: ({ z, personal }: EventPayloadArgs) => z.object({ name: personal(z.string()) }),
          evolve: () => ({}),
        },
      },
      commands: {
        registerCustomer: {
          module: {
            payload: ({ z }: PayloadArgs) => z.object({ customerId: z.string(), name: z.string() }),
            handler: ({
              command,
              events,
            }: {
              command: { payload: { name: string } };
              events: Record<string, (payload?: unknown) => unknown>;
            }) => [events.customerRegistered?.({ name: command.payload.name })],
          },
        },
      },
      policies: {},
      processes: {},
    },
  },
  readModels: {},
} as unknown as Registry;

export const TEST_ENV = { BOUNDA_MASTER_KEY: "5hmVukCECFtCyFw3rgVhT/y8hR2OrZBY5JonQlvHN1U=" };

export interface TestAppPaths {
  readonly store: string;
  readonly keys: string;
}

export interface BootTestAppOptions {
  readonly encrypt?: boolean;
  readonly logger?: Logger;
  readonly clock?: Clock;
}

// A day ahead: past the wait before the tenant key's older versions can be retired.
export const dayAhead: Clock = {
  now: () => new Date(Date.now() + 86_400_000),
  after: (milliseconds, callback, options) => systemClock.after(milliseconds, callback, options),
};

export const bootTestApp = (
  { store, keys }: TestAppPaths,
  { encrypt = true, logger, clock }: BootTestAppOptions = {},
): Promise<BoundaApp> =>
  createApp({
    registry: testRegistry,
    config: {
      storage: sqlite({ path: store, encrypt }),
      runtime: {
        personalData: {
          keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }),
          tenantKeys: sqlite({ path: keys }),
        },
      },
    },
    env: TEST_ENV,
    ...(logger === undefined ? {} : { logger }),
    ...(clock === undefined ? {} : { clock }),
  });

export const registerCustomer = async (app: BoundaApp, customerId: string): Promise<void> => {
  const commands = app.commands as unknown as Record<
    string,
    (payload: { customerId: string; name: string }) => Promise<unknown>
  >;
  await commands.registerCustomer?.({ customerId, name: `name of ${customerId}` });
};

export const nameOf = async (app: BoundaApp, customerId: string): Promise<unknown> =>
  (await app.exportPersonalData(customerId)).events[0]?.data.name;
