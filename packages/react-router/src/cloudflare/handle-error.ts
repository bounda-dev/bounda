import { env } from "cloudflare:workers";
import { workersLogger } from "@bounda-dev/cloudflare";
import { type Logger, resolveErrorText } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import { createHandleError, type HandleBoundaErrorFunction } from "../handle-error.ts";

export interface CloudflareHandleErrorArgs {
  /**
   * The configuration the Worker holds, `undefined` while it has imported none.
   */
  readonly config: () => Config | undefined;
  readonly logger?: Logger | undefined;
}

export interface CloudflareHandleErrorFunction {
  (args: CloudflareHandleErrorArgs): HandleBoundaErrorFunction;
}

// The configuration is one bundle for every environment, so the Worker's `env` decides first, as
// it does for the Durable Object.
export const cloudflareHandleError: CloudflareHandleErrorFunction = ({
  config,
  logger = workersLogger,
}) =>
  createHandleError({
    message: "bounda request failed",
    errorText: () => resolveErrorText({ env, config: config(), invalidEnv: "ignore" }),
    logger: () => logger,
  });
