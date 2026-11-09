import { env } from "cloudflare:workers";
import { workersLogger } from "@bounda-dev/cloudflare";
import type { Logger } from "@bounda-dev/core";
import type { Config } from "@bounda-dev/core/config";
import {
  createHandleError,
  errorTextOfEnv,
  type HandleBoundaErrorFunction,
} from "../handle-error.ts";

export interface CloudflareHandleErrorArgs {
  /**
   * The text is omitted when it rejects.
   */
  readonly config: () => Promise<Config | undefined>;
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
    errorText: async () =>
      errorTextOfEnv(() => env) ??
      (await config().catch(() => undefined))?.runtime?.telemetry?.errorText ??
      "omit",
    logger: () => logger,
  });
