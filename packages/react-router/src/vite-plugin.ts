import { join, resolve, sep } from "node:path";
import type { Clock } from "@bounda-dev/core";
import type { Logger, Plugin } from "vite";
import { APP_MODULE_ID } from "./app-module.ts";
import type { Consistency } from "./create-bounda.ts";
import type { BoundaVitePluginOptions } from "./vite.ts";

export interface CreateBoundaPluginArgs extends BoundaVitePluginOptions {
  /**
   * What the regeneration debounce waits on.
   */
  readonly clock: Clock;
}

export interface CreateBoundaPluginFunction {
  (args: CreateBoundaPluginArgs): Plugin;
}

const RESOLVED_ID = `\0${APP_MODULE_ID}`;
const PACKAGE_ID = "@bounda-dev/react-router";
/**
 * Vite externalises anything it finds in `node_modules` when it renders on the server, and an
 * externalised import is loaded by Node without passing through a plugin, so `resolveId` below
 * would never get to serve the app module. `noExternal` is matched against the package, not
 * against the subpath, hence the whole package. A workspace link is internal already, which is
 * why this only shows up once the package is installed from a registry.
 */
const PACKAGE_PATTERN = /^@bounda-dev\/react-router(\/|$)/;
const APP_DIRECTORY = "app";
const WATCHED = ["domain", "read"];
const EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;

const serverModule = (root: string, consistency: Consistency): string =>
  [
    'import { boot } from "@bounda-dev/core/node";',
    'import { createBounda } from "@bounda-dev/react-router";',
    `import { registry } from ${JSON.stringify(join(root, ".bounda/registry.ts"))};`,
    "",
    "export const { bounda, boundaMiddleware, dispose } = createBounda({",
    `  boot: () => boot({ root: ${JSON.stringify(root)}, registry }),`,
    `  consistency: ${JSON.stringify(consistency)},`,
    "});",
    "",
  ].join("\n");

const clientModule = (): string =>
  [
    "const serverOnly = () => {",
    `  throw new Error(${JSON.stringify(`${APP_MODULE_ID} is server-only: use it in loaders, actions and middleware, not in components`)});`,
    "};",
    "export const bounda = new Proxy({}, { get: serverOnly });",
    "export const boundaMiddleware = serverOnly;",
    "export const dispose = serverOnly;",
    "",
  ].join("\n");

interface Generation {
  readonly root: string;
  readonly logger: Logger;
  readonly failOnConvention: boolean;
}

const regenerate = async ({ root, logger, failOnConvention }: Generation): Promise<void> => {
  const cli = await import("@bounda-dev/cli");
  try {
    const report = await cli.generate({ root });
    const warnings = cli.formatWarnings(report);
    if (warnings !== "") logger.warn(`[bounda] ${warnings}`);
  } catch (error) {
    if (error instanceof cli.ConventionError && !failOnConvention) {
      logger.error(`[bounda] ${cli.formatConventionError({ error, root })}`);
      return;
    }
    throw error;
  }
};

/**
 * The plugin behind `bounda()`, waiting on `clock` between a burst of changes and the
 * regeneration it causes. `closeBundle`, which Vite awaits when the server closes, drops a
 * regeneration still waiting and waits for the one running.
 */
export const createBoundaPlugin: CreateBoundaPluginFunction = ({
  consistency = "immediate",
  debounceMs = 100,
  clock,
}) => {
  let generation: Generation | undefined;
  let queue: Promise<void> = Promise.resolve();
  let cancelPending: (() => void) | undefined;
  const isWatched = (root: string, file: string): boolean =>
    WATCHED.some((directory) => file.startsWith(resolve(root, APP_DIRECTORY, directory) + sep)) &&
    !file.split(sep).includes("+types");

  return {
    name: "bounda",
    enforce: "pre",
    configEnvironment: (name) =>
      name === "client"
        ? { optimizeDeps: { exclude: [PACKAGE_ID] } }
        : { resolve: { noExternal: [PACKAGE_PATTERN] } },
    configResolved(config) {
      generation = {
        root: config.root,
        logger: config.logger,
        failOnConvention: config.command === "build",
      };
    },
    async buildStart() {
      if (generation !== undefined) await regenerate(generation);
    },
    configureServer(server) {
      const schedule = (file: string): void => {
        const current = generation;
        if (current === undefined || !isWatched(current.root, file)) return;
        cancelPending?.();
        cancelPending = clock.after(debounceMs, () => {
          cancelPending = undefined;
          queue = queue
            .then(() => regenerate({ ...current, failOnConvention: false }))
            .catch((error: unknown) => {
              current.logger.error(
                `[bounda] ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        });
      };
      for (const event of EVENTS) server.watcher.on(event, schedule);
    },
    async closeBundle() {
      cancelPending?.();
      cancelPending = undefined;
      await queue;
    },
    resolveId(id) {
      return id === APP_MODULE_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID || generation === undefined) return null;
      return this.environment.config.consumer === "client"
        ? clientModule()
        : serverModule(generation.root, consistency);
    },
  };
};
