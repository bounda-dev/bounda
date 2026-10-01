/// <reference lib="esnext.disposable" />
import { selectCollaborators } from "../../config/collaborators.ts";
import type { CollaboratorsConfig } from "../../config/types.ts";
import type { Clock } from "../../contracts/clock.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { Logger } from "../../contracts/logger.ts";
import type { Registry } from "../../modules/registry.ts";
import type { AppEnv } from "../../register/index.ts";
import { errorDetails } from "../shared/retry.ts";

/**
 * The ports every handler of an aggregate receives, by aggregate and then by port.
 */
export type AggregateCollaborators = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

export interface CreateCollaboratorsArgs {
  readonly registry: Registry;
  readonly config: CollaboratorsConfig;
  readonly env: AppEnv;
  readonly logger: Logger;
  readonly clock: Clock;
}

export interface CreatedCollaborators {
  readonly byAggregate: AggregateCollaborators;
  /**
   * Closes what the `create` exports built, in reverse order. Never fails: a close that throws is
   * logged and the rest still close.
   */
  dispose(): Promise<void>;
}

export interface CreateCollaboratorsFunction {
  (args: CreateCollaboratorsArgs): Promise<CreatedCollaborators>;
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
 * creation; a `default` export is shared by every app the process holds and is never closed.
 */
export const createCollaborators: CreateCollaboratorsFunction = async ({
  registry,
  config,
  env,
  logger,
  clock,
}) => {
  for (const name of Object.keys(config)) {
    if (!Object.hasOwn(registry.aggregates, name)) {
      throw new ConfigurationError(
        `collaborators.${name}: there is no aggregate "${name}" whose collaborators to choose`,
      );
    }
  }
  const selected = Object.entries(registry.aggregates).map(
    ([aggregate, entry]) =>
      [
        aggregate,
        selectCollaborators({
          aggregate,
          implementations: entry.collaborators ?? {},
          config: config[aggregate],
        }),
      ] as const,
  );
  const disposers: Disposer[] = [];
  const dispose = async (): Promise<void> => {
    for (const { aggregate, port, close } of disposers.toReversed()) {
      try {
        await close();
      } catch (error) {
        logger.error("collaborator could not be closed", {
          aggregate,
          collaborator: port,
          ...errorDetails(error),
        });
      }
    }
  };
  const byAggregate: Record<string, Readonly<Record<string, unknown>>> = {};
  try {
    for (const [aggregate, modules] of selected) {
      const ports: Record<string, unknown> = {};
      for (const [port, module] of Object.entries(modules)) {
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
