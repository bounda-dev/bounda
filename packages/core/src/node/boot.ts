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

/**
 * What `boot` loads and how. Every field is optional: by default it reads the project in the
 * current directory as `bounda generate` lays it out.
 */
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
   * Imports the configuration module instead of `configPath`, after `.env` is loaded; its
   * default export is the configuration. For a bundler that has to see the import to include the
   * configuration in its output, such as Vite.
   */
  readonly importConfig?: ImportModuleFunction;
  /**
   * Used instead of importing `registryPath`.
   */
  readonly registry?: R;
  /**
   * Whether to load `.env` from `root` into `process.env` before the configuration is imported.
   * Defaults to `true`; variables already set are never overwritten.
   */
  readonly loadEnv?: boolean;
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

/**
 * Imports a module and resolves with its namespace: `() => import("./bounda.config.ts")`.
 */
export interface ImportModuleFunction {
  (): Promise<Readonly<Record<string, unknown>>>;
}

export interface BootFunction {
  <R extends Registry = AppRegistry>(args?: BootArgs<R>): Promise<BoundaApp<R>>;
}

export type LoadProjectArgs<R extends Registry = AppRegistry> = Pick<
  BootArgs<R>,
  | "root"
  | "configPath"
  | "registryPath"
  | "config"
  | "importConfig"
  | "registry"
  | "loadEnv"
  | "logger"
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

const importFile =
  (path: string, what: string): ImportModuleFunction =>
  async () => {
    if (!(await exists(path))) {
      throw new ConfigurationError(`Cannot find ${what} at ${path}`);
    }
    return (await import(/* @vite-ignore */ pathToFileURL(path).href)) as Record<string, unknown>;
  };

const importExport = async <T>(
  load: ImportModuleFunction,
  source: string,
  what: string,
  pick: (module: Readonly<Record<string, unknown>>) => T | undefined,
): Promise<T> => {
  const value = pick(await load());
  if (value === undefined) {
    throw new ConfigurationError(`${source} does not export ${what}`);
  }
  return value;
};

const CONFIG = "the configuration (default export)";
const REGISTRY = 'the registry (export "registry")';

const loadEnvFile = (root: string, logger: Logger): void => {
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
  importConfig,
  registry,
  loadEnv = true,
  logger = createConsoleLogger(),
}: LoadProjectArgs<R> = {}): Promise<LoadedProject<R>> => {
  if (loadEnv) loadEnvFile(root, guardedLogger(logger));
  const configFile = resolve(root, configPath);
  const registryFile = resolve(root, registryPath);
  return {
    config:
      config ??
      (await importExport<Config>(
        importConfig ?? importFile(configFile, CONFIG),
        importConfig === undefined ? configFile : "The imported configuration module",
        CONFIG,
        (module) => module.default as Config | undefined,
      )),
    registry:
      registry ??
      (await importExport<R>(
        importFile(registryFile, REGISTRY),
        registryFile,
        REGISTRY,
        (module) => module.registry as R | undefined,
      )),
  };
};

/**
 * Boots a Bounda app in Node: loads `.env`, imports the configuration and the generated registry,
 * creates the app with `process.env` as the environment implementations' `create` receives, and
 * stops it on `SIGINT` or `SIGTERM`; stopping the app removes those listeners again. Throws
 * `ConfigurationError` when a module is missing or lacks its export.
 */
export const boot: BootFunction = async <R extends Registry = AppRegistry>({
  root = process.cwd(),
  configPath = "bounda.config.ts",
  registryPath = ".bounda/registry.ts",
  config,
  importConfig,
  registry,
  loadEnv = true,
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
    ...(importConfig === undefined ? {} : { importConfig }),
    ...(registry === undefined ? {} : { registry }),
    loadEnv,
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
