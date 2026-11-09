import type { ErrorText } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";

/**
 * The environment variable that sets `runtime.telemetry.errorText` for a running app, over what
 * the configuration says: `"omit"` or `"include"`.
 */
export const ERROR_TEXT_VARIABLE: "BOUNDA_ERROR_TEXT" = "BOUNDA_ERROR_TEXT";

export interface ErrorTextFromEnvFunction {
  (env: object): ErrorText | undefined;
}

/**
 * What `BOUNDA_ERROR_TEXT` asks of the app, `undefined` when it is unset or empty. `boot()`, the
 * CLI and the Durable Object and Worker of `@bounda-dev/cloudflare` read it, so a deployment, or
 * `.dev.vars` in development, turns the text of errors on or off without touching the
 * configuration; a host's own override, such as `bounda --error-text`, still wins. Throws
 * `ConfigurationError` for any other value.
 */
export const errorTextFromEnv: ErrorTextFromEnvFunction = (env) => {
  const value: unknown = Reflect.get(env, ERROR_TEXT_VARIABLE);
  if (value === undefined || value === "") return undefined;
  if (value === "omit" || value === "include") return value;
  throw new ConfigurationError(
    `${ERROR_TEXT_VARIABLE} must be "omit" or "include", not ${JSON.stringify(value)}`,
  );
};
