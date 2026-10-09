import { join, resolve, sep } from "node:path";
import type { Clock, Consistency } from "@bounda-dev/core";
import type { Logger, Plugin } from "vite";
import { APP_MODULE_ID } from "./app-module.ts";
import type { BoundaVitePluginOptions } from "./vite.ts";

export interface CreateBoundaPluginArgs extends BoundaVitePluginOptions {
  readonly clock: Clock;
}

export interface CreateBoundaPluginFunction {
  (args: CreateBoundaPluginArgs): Plugin;
}

const RESOLVED_ID = `\0${APP_MODULE_ID}`;
const PACKAGE_ID = "@bounda-dev/react-router";
/**
 * Vite externalises `node_modules` on the server, and Node loads an external import without
 * asking any plugin, so `resolveId` would never serve the app module. `noExternal` matches the
 * package, not the subpath. A workspace link is never external, so only an install from a
 * registry shows it.
 */
const PACKAGE_PATTERN = /^@bounda-dev\/react-router(\/|$)/;
const APP_DIRECTORY = "app";
const CONFIG_FILE = "bounda.config.ts";
const WATCHED = ["domain", "read"];
const EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;

/**
 * The registry and the configuration are imported here rather than by `boot`, so that Vite
 * re-evaluates this module, and the app reboots, whenever either changes, and so that a build
 * bundles both. The configuration is imported once `boot` has loaded `.env`, which it may read.
 * Only the dev server pins `root`: a build runs wherever it is deployed, from the working
 * directory.
 */
const serverModule = ({ root, command }: Generation, consistency: Consistency): string => {
  const options = [
    ...(command === "serve" ? [`root: ${JSON.stringify(root)}`] : []),
    "registry",
    `importConfig: () => import(${JSON.stringify(join(root, CONFIG_FILE))})`,
  ];
  return [
    'import { boot } from "@bounda-dev/core/node";',
    'import { createBounda } from "@bounda-dev/react-router";',
    `import { registry } from ${JSON.stringify(join(root, ".bounda/registry.ts"))};`,
    "",
    "export const { bounda, boundaMiddleware, dispose } = createBounda({",
    `  boot: () => boot({ ${options.join(", ")} }),`,
    `  consistency: ${JSON.stringify(consistency)},`,
    "});",
    'export { failure } from "@bounda-dev/react-router";',
    "",
  ].join("\n");
};

const clientModule = (): string =>
  [
    "const serverOnly = () => {",
    `  throw new Error(${JSON.stringify(`${APP_MODULE_ID} is server-only: use it in loaders, actions and middleware, not in components`)});`,
    "};",
    "export const bounda = new Proxy({}, { get: serverOnly });",
    "export const boundaMiddleware = serverOnly;",
    "export const dispose = serverOnly;",
    "export const failure = serverOnly;",
    "",
  ].join("\n");

interface Generation {
  readonly root: string;
  readonly logger: Logger;
  readonly command: "serve" | "build";
}

interface Regeneration extends Pick<Generation, "root" | "logger"> {
  readonly failOnConvention: boolean;
}

const regenerate = async ({ root, logger, failOnConvention }: Regeneration): Promise<void> => {
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

export const createBoundaPlugin: CreateBoundaPluginFunction = ({
  consistency = "read-your-writes",
  debounceMs = 100,
  clock,
}) => {
  let generation: Generation | undefined;
  let generated: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let cancelPending: (() => void) | undefined;
  const isWatched = (root: string, file: string): boolean =>
    WATCHED.some((directory) => file.startsWith(resolve(root, APP_DIRECTORY, directory) + sep)) &&
    !file.split(sep).includes("+types");

  return {
    name: "bounda",
    enforce: "pre",
    // One instance for every environment of a build, so `buildStart` generates once.
    sharedDuringBuild: true,
    configEnvironment: (name) =>
      name === "client"
        ? { optimizeDeps: { exclude: [PACKAGE_ID] } }
        : { resolve: { noExternal: [PACKAGE_PATTERN] } },
    configResolved(config) {
      generation = { root: config.root, logger: config.logger, command: config.command };
    },
    async buildStart() {
      const current = generation;
      if (current === undefined) return;
      const run = () => regenerate({ ...current, failOnConvention: current.command === "build" });
      // A watching build starts again after every change, and each start has to see it.
      generated = this.meta.watchMode ? run() : (generated ?? run());
      await generated;
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
    /**
     * Vite awaits it when the server closes, so no regeneration writes after the server is gone.
     */
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
        : serverModule(generation, consistency);
    },
  };
};
