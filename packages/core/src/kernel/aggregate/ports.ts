/// <reference lib="esnext.disposable" />
import { selectImplementations } from "../../config/ports.ts";
import type { PortsConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { Registry } from "../../modules/registry.ts";
import type { AppEnv, TestPortsChoice } from "../../register/index.ts";
import { errorDetails } from "../shared/retry.ts";
import { type PortChoice, selectTestImplementations } from "./test-ports.ts";

/**
 * The ports every handler of an aggregate receives, by aggregate and then by port.
 */
export type AggregatePorts = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * How a test app chooses: only what the test names is built, and a port it leaves out has no
 * implementation, so reading it throws a `ConfigurationError`, which `onMissing` hears first.
 */
export interface TestChoice {
  readonly ports: TestPortsChoice;
  onMissing(error: ConfigurationError): void;
}

export type CreatePortsArgs = {
  readonly registry: Registry;
  readonly env: AppEnv;
  readonly logger: Logger;
  readonly clock: Clock;
} & ({ readonly config: PortsConfig } | { readonly test: TestChoice });

export interface CreatedPorts {
  readonly byAggregate: AggregatePorts;
  /**
   * Closes what the `create` exports built, in reverse order. Never fails: a close that throws is
   * logged and the rest still close.
   */
  dispose(): Promise<void>;
}

export interface CreatePortsFunction {
  (args: CreatePortsArgs): Promise<CreatedPorts>;
}

interface Disposer {
  readonly aggregate: string;
  readonly port: string;
  readonly close: () => Promise<void>;
}

const disposerOf = (port: unknown): (() => Promise<void>) | undefined => {
  if (typeof port !== "function" && (typeof port !== "object" || port === null)) return undefined;
  const dispose: unknown = Reflect.get(port, Symbol.asyncDispose);
  if (typeof dispose !== "function") return undefined;
  return async () => {
    await (dispose as (this: unknown) => unknown).call(port);
  };
};

/**
 * Chooses every aggregate's implementations before building any, so a configuration error never
 * leaves a client open. `create` runs one at a time, so closing in reverse undoes the order of
 * creation; a `default` export is shared by every app the process holds, and a test's double
 * belongs to the test, so neither is ever closed.
 */
export const createPorts: CreatePortsFunction = async (args) => {
  const { registry, env, logger, clock } = args;
  const test = "test" in args ? args.test : undefined;
  const config = "config" in args ? args.config : {};
  for (const name of Object.keys(test?.ports ?? config)) {
    if (!Object.hasOwn(registry.aggregates, name)) {
      throw new ConfigurationError(
        `ports.${name}: there is no aggregate "${name}" whose ports to choose`,
      );
    }
  }
  const selected = Object.entries(registry.aggregates).map(([aggregate, entry]) => {
    const implementations = entry.ports ?? {};
    const choices: Readonly<Record<string, PortChoice>> =
      test === undefined
        ? Object.fromEntries(
            Object.entries(
              selectImplementations({ aggregate, implementations, config: config[aggregate] }),
            ).map(([port, module]) => [port, { module }]),
          )
        : selectTestImplementations({
            aggregate,
            implementations,
            chosen: test.ports[aggregate],
          });
    return [aggregate, choices] as const;
  });
  const disposers: Disposer[] = [];
  const dispose = async (): Promise<void> => {
    for (const { aggregate, port, close } of disposers.toReversed()) {
      try {
        await close();
      } catch (error) {
        logger.error("implementation could not be closed", {
          aggregate,
          port,
          ...errorDetails(error),
        });
      }
    }
  };
  const byAggregate: Record<string, Readonly<Record<string, unknown>>> = {};
  try {
    for (const [aggregate, choices] of selected) {
      const ports: Record<string, unknown> = {};
      for (const [port, choice] of Object.entries(choices)) {
        if ("missing" in choice) {
          const { missing } = choice;
          Object.defineProperty(ports, port, {
            enumerable: true,
            get: () => {
              const error = missing();
              test?.onMissing(error);
              throw error;
            },
          });
          continue;
        }
        if ("double" in choice) {
          ports[port] = choice.double;
          continue;
        }
        const { module } = choice;
        if (module.create === undefined) {
          ports[port] = module.default;
          continue;
        }
        const created = await module.create({ env, logger, clock });
        const close = disposerOf(created);
        if (close !== undefined) disposers.push({ aggregate, port, close });
        ports[port] = created;
      }
      byAggregate[aggregate] = ports;
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return { byAggregate, dispose };
};
