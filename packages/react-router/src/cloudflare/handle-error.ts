import { env } from "cloudflare:workers";
import { hostLogger, workersLogger } from "@bounda-dev/cloudflare";
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
  /**
   * The `handleError` of `host`, what the Worker serves requests through, which a test may give a
   * witness with `witnessObjects`.
   */
  (args: CloudflareHandleErrorArgs): (host: object) => HandleBoundaErrorFunction;
}

// The configuration is one bundle for every environment, so the Worker's `env` decides first, as
// it does for the Durable Object.
export const cloudflareHandleError: CloudflareHandleErrorFunction =
  ({ config, logger = workersLogger }) =>
  (host) =>
    createHandleError({
      message: "bounda request failed",
      errorText: () => resolveErrorText({ env, config: config(), ignoreInvalidEnv: true }),
      logger: () => hostLogger(host, logger),
    });
