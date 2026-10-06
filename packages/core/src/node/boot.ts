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
import { guardedLogger } from "../kernel/shared/guarded-logger.ts";
import type { Registry } from "../modules/registry.ts";
import type { AppRegistry } from "../register/index.ts";
import { createConsoleLogger } from "./console-logger.ts";

export interface BootArgs<R extends Registry = AppRegistry> {
  /**
   * The directory the other paths and `.env` are resolved against. Defaults to the current
   * working directory.
   */
  readonly root?: string;
  /**
   * The configuration module, relative to `root`. Defaults to `bounda.config.ts`.
   */
  readonly configPath?: string;
  /**
   * The generated registry module, relative to `root`. Defaults to `.bounda/registry.ts`.
   */
  readonly registryPath?: string;
  /**
   * Used instead of importing `configPath`.
   */
  readonly config?: Config;
  /**
   * Used instead of importing `registryPath`.
   */
  readonly registry?: R;
  /**
   * Whether to load `.env` from `root` into `process.env` before the configuration is imported.
   * Defaults to `true`; variables already set are never overwritten.
   */
  readonly env?: boolean;
  /**
   * Whether `SIGINT` and `SIGTERM` stop the app. Defaults to `true`.
   */
  readonly signals?: boolean;
  /**
   * Defaults to `createConsoleLogger()`.
   */
  readonly logger?: Logger;
  /**
   * Defaults to `uuidV7IdGenerator`.
   */
  readonly ids?: IdGenerator;
  /**
   * Defaults to `systemClock`.
   */
  readonly clock?: Clock;
}

export interface BootFunction {
  <R extends Registry = AppRegistry>(args?: BootArgs<R>): Promise<BoundaApp<R>>;
}

export type LoadProjectArgs<R extends Registry = AppRegistry> = Pick<
  BootArgs<R>,
  "root" | "configPath" | "registryPath" | "config" | "registry" | "env" | "logger"
>;

export interface LoadedProject<R extends Registry = AppRegistry> {
  readonly config: Config;
  readonly registry: R;
}

export interface LoadProjectFunction {
  <R extends Registry = AppRegistry>(args?: LoadProjectArgs<R>): Promise<LoadedProject<R>>;
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
  const module = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as Record<
    string,
    unknown
  >;
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
 * What `boot()` does before creating the app: loads `.env`, then imports the configuration and
 * the generated registry. For tooling that needs the project but not a running app, such as
 * `bounda rebuild`. Throws `ConfigurationError` when a module is missing or lacks its export.
 */
export const loadProject: LoadProjectFunction = async <R extends Registry = AppRegistry>({
  root = process.cwd(),
  configPath = "bounda.config.ts",
  registryPath = ".bounda/registry.ts",
  config,
  registry,
  env = true,
  logger = createConsoleLogger(),
}: LoadProjectArgs<R> = {}): Promise<LoadedProject<R>> => {
  if (env) loadEnv(root, guardedLogger(logger));
  return {
    config:
      config ??
      (await importModule<Config>(
        resolve(root, configPath),
        "the configuration (default export)",
        (module) => module.default as Config | undefined,
      )),
    registry:
      registry ??
      (await importModule<R>(
        resolve(root, registryPath),
        'the registry (export "registry")',
        (module) => module.registry as R | undefined,
      )),
  };
};

/**
 * Boots a Bounda app in Node: loads `.env`, imports the configuration and the generated registry,
 * creates the app with `process.env` as the environment collaborators' `create` receives, and
 * stops it on `SIGINT` or `SIGTERM`; stopping the app removes those listeners again. Throws
 * `ConfigurationError` when a module is missing or lacks its export.
 */
export const boot: BootFunction = async <R extends Registry = AppRegistry>({
  root = process.cwd(),
  configPath = "bounda.config.ts",
  registryPath = ".bounda/registry.ts",
  config,
  registry,
  env = true,
  signals = true,
  logger: rawLogger = createConsoleLogger(),
  ids,
  clock,
}: BootArgs<R> = {}): Promise<BoundaApp<R>> => {
  const logger = guardedLogger(rawLogger);
  const project = await loadProject<R>({
    root,
    configPath,
    registryPath,
    ...(config === undefined ? {} : { config }),
    ...(registry === undefined ? {} : { registry }),
    env,
    logger,
  });

  const app = await createApp<R>({
    registry: project.registry,
    config: project.config,
    logger,
    env: process.env,
    ...(ids === undefined ? {} : { ids }),
    ...(clock === undefined ? {} : { clock }),
  });

  if (!signals) return app;
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info("stopping", { signal });
    void stop();
  };
  const stop = async (): Promise<void> => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await app.stop();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { ...app, stop };
};
