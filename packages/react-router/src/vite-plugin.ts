import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, Consistency } from "@bounda-dev/core";
import { type Logger, normalizePath, type Plugin } from "vite";
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
const HOST_ID = `${PACKAGE_ID}/host`;
/**
 * Vite externalises `node_modules` on the server, and Node loads an external import without
 * asking any plugin, so `resolveId` would never serve the app module. `noExternal` matches the
 * package, not the subpath. A workspace link is never external, so only an install from a
 * registry shows it.
 */
const PACKAGE_PATTERN = /^@bounda-dev\/react-router(\/|$)/;
const APP_DIRECTORY = "app";
const CONFIG_FILE = "bounda.config.ts";
const TENANT_FILE = "tenant.ts";
const ACTOR_FILE = "actor.ts";
const WATCHED = ["domain", "read"];
const ENTRY_SERVER = /^entry\.server\.[cm]?[jt]sx?$/;
const EXPORTS_HANDLE_ERROR =
  /export\s+(?:async\s+)?(?:function\*?|const|let|var)\s+handleError\b|export\s*\{[^}]*\bhandleError\b[^}]*\}/;
const LOGGING_ERRORS = "https://docs.bounda.dev/guides/react-router/#logging-errors";
const EVENTS = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;

/**
 * The registry and the configuration are imported here rather than by the host, so that Vite
 * re-evaluates this module, and the app reboots, whenever either changes, and so that a build
 * bundles both. In Node the configuration is imported once `boot` has loaded `.env`, which it may
 * read. Only the dev server pins `root`, since a build runs wherever it is deployed, from the
 * working directory, and logs the text of errors unless the configuration says otherwise. The `workerd` condition picks the Cloudflare host. The globs make `app/tenant.ts` and
 * `app/actor.ts` optional, and Vite serves this module again when either appears or goes. Paths go in with `/`,
 * Vite's form on every platform.
 */
const serverModule = ({ root, command }: Generation, consistency: Consistency): string =>
  [
    `import { createHost } from ${JSON.stringify(HOST_ID)};`,
    `import { registry } from ${JSON.stringify(normalizePath(join(root, ".bounda/registry.ts")))};`,
    "",
    "export const { bounda, boundaMiddleware, dispose, handleError } = createHost({",
    ...(command === "serve" ? [`  root: ${JSON.stringify(root)},`, '  errorText: "include",'] : []),
    "  registry,",
    `  importConfig: () => import(${JSON.stringify(normalizePath(join(root, CONFIG_FILE)))}),`,
    `  importTenant: Object.values(import.meta.glob(${JSON.stringify(`/${APP_DIRECTORY}/${TENANT_FILE}`)}))[0],`,
    `  importActor: Object.values(import.meta.glob(${JSON.stringify(`/${APP_DIRECTORY}/${ACTOR_FILE}`)}))[0],`,
    `  consistency: ${JSON.stringify(consistency)},`,
    "});",
    `export { failure } from ${JSON.stringify(HOST_ID)};`,
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
    "export const handleError = serverOnly;",
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

// Without its own `handleError`, React Router logs every message and stack, in production too.
const checkEntryServer = async ({ root, logger }: Pick<Generation, "root" | "logger">) => {
  const directory = join(root, APP_DIRECTORY);
  const files = await readdir(directory).catch((): string[] => []);
  const name = files.find((file) => ENTRY_SERVER.test(file));
  const source = name === undefined ? "" : await readFile(join(directory, name), "utf8");
  if (EXPORTS_HANDLE_ERROR.test(source)) return;
  logger.warn(
    `[bounda] ${name === undefined ? `${APP_DIRECTORY}/entry.server.tsx is missing` : `${APP_DIRECTORY}/${name} does not export handleError`}, so React Router logs the message and the stack of whatever a loader, an action or the render throws, and a message may quote personal data. Export Bounda's from it: export { handleError } from "${APP_MODULE_ID}"; see ${LOGGING_ERRORS}`,
  );
};

export const createBoundaPlugin: CreateBoundaPluginFunction = ({
  consistency = "read-your-writes",
  debounceMs = 100,
  clock,
}) => {
  let generation: Generation | undefined;
  let generated: Promise<void> | undefined;
  let entryChecked = false;
  let queue: Promise<void> = Promise.resolve();
  let cancelPending: (() => void) | undefined;
  // Both sides in Vite's form, so the watcher's separator, `\` on Windows, does not matter.
  const isWatched = (root: string, file: string): boolean => {
    const path = normalizePath(file);
    return (
      WATCHED.some((directory) =>
        path.startsWith(`${normalizePath(join(root, APP_DIRECTORY, directory))}/`),
      ) && !path.split("/").includes("+types")
    );
  };

  return {
    name: "bounda",
    enforce: "pre",
    // One instance for every environment of a build, so `buildStart` generates once.
    sharedDuringBuild: true,
    configEnvironment: (name, config) =>
      name === "client"
        ? { optimizeDeps: { exclude: [PACKAGE_ID] } }
        : {
            resolve: { noExternal: [PACKAGE_PATTERN] },
            // A Worker's environment pre-bundles its dependencies, and only the app module imports
            // the host: found on the first request, it would make Vite pre-bundle again and reload.
            ...(config.resolve?.conditions?.includes("workerd")
              ? { optimizeDeps: { include: [HOST_ID] } }
              : {}),
          },
    configResolved(config) {
      generation = { root: config.root, logger: config.logger, command: config.command };
    },
    async buildStart() {
      const current = generation;
      if (current === undefined) return;
      const run = () => regenerate({ ...current, failOnConvention: current.command === "build" });
      // A watching build starts again after every change, and each start has to see it.
      generated = this.meta.watchMode ? run() : (generated ?? run());
      if (!entryChecked) {
        entryChecked = true;
        await checkEntryServer(current);
      }
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
