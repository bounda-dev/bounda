/// <reference types="node" />
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/types.ts";
import type { Clock } from "../contracts/clock.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import type { IdGenerator } from "../contracts/ids.ts";
import type { Logger } from "../contracts/logger.ts";
import { type BoundaApp, createApp } from "../kernel/app.ts";
import type { Registry } from "../modules/registry.ts";
import { createConsoleLogger } from "./console-logger.ts";

export interface BootArgs<R extends Registry = Registry> {
  /**
   * The project root. Defaults to the current working directory.
   */
  readonly root?: string;
  /**
   * Path of the configuration module, relative to `root`. Defaults to `bounda.config.ts`.
   */
  readonly configPath?: string;
  /**
   * Path of the generated registry module, relative to `root`. Defaults to `.bounda/registry.ts`.
   */
  readonly registryPath?: string;
  /**
   * A configuration to use instead of importing one.
   */
  readonly config?: Config;
  /**
   * A registry to use instead of importing one.
   */
  readonly registry?: R;
  /**
   * Whether to load `.env` from `root` into `process.env` before importing the configuration.
   * Defaults to `true`; existing variables are never overwritten.
   */
  readonly env?: boolean;
  /**
   * Whether `SIGINT` and `SIGTERM` stop the app. Defaults to `true`.
   */
  readonly signals?: boolean;
  readonly logger?: Logger;
  readonly ids?: IdGenerator;
  readonly clock?: Clock;
}

export interface BootFunction {
  <R extends Registry = Registry>(args?: BootArgs<R>): Promise<BoundaApp<R>>;
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const importModule = async <T>(
  path: string,
  what: string,
  pick: (module: Record<string, unknown>) => T | undefined,
): Promise<T> => {
  if (!(await exists(path))) {
    throw new ConfigurationError(`Cannot find ${what} at ${path}`);
  }
  const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const value = pick(module);
  if (value === undefined) {
    throw new ConfigurationError(`${path} does not export ${what}`);
  }
  return value;
};

const loadEnv = (root: string, logger: Logger): void => {
  const path = resolve(root, ".env");
  try {
    process.loadEnvFile(path);
    logger.debug("environment loaded", { path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/**
 * Boots a Bounda app in Node: loads `.env`, imports `bounda.config.ts` and the generated
 * registry from the project root, creates the app and stops it on `SIGINT` or `SIGTERM`. Every
 * piece can be supplied directly instead of imported.
 */
export const boot: BootFunction = async <R extends Registry = Registry>({
  root = process.cwd(),
  configPath = "bounda.config.ts",
  registryPath = ".bounda/registry.ts",
  config,
  registry,
  env = true,
  signals = true,
  logger = createConsoleLogger(),
  ids,
  clock,
}: BootArgs<R> = {}): Promise<BoundaApp<R>> => {
  if (env) loadEnv(root, logger);
  const resolvedConfig =
    config ??
    (await importModule<Config>(
      resolve(root, configPath),
      "the configuration (default export)",
      (module) => module.default as Config | undefined,
    ));
  const resolvedRegistry =
    registry ??
    (await importModule<R>(
      resolve(root, registryPath),
      'the registry (export "registry")',
      (module) => module.registry as R | undefined,
    ));

  const app = await createApp<R>({
    registry: resolvedRegistry,
    config: resolvedConfig,
    logger,
    ...(ids === undefined ? {} : { ids }),
    ...(clock === undefined ? {} : { clock }),
  });

  if (signals) {
    const onSignal = (signal: NodeJS.Signals): void => {
      logger.info("stopping", { signal });
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      void app.stop();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return app;
};
