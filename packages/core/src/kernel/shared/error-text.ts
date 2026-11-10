import type { Config, ErrorText } from "../../config/types.ts";
import { ConfigurationError } from "../../contracts/errors.ts";

/**
 * The environment variable that sets `runtime.telemetry.errorText` for a running app, over what
 * the configuration says: `"omit"` or `"include"`.
 */
export const ERROR_TEXT_VARIABLE: "BOUNDA_ERROR_TEXT" = "BOUNDA_ERROR_TEXT";

export interface ResolveErrorTextArgs {
  /**
   * A host's own override, such as `bounda --error-text` or `boot({ errorText })`.
   */
  readonly forced?: ErrorText | undefined;
  /**
   * Where `BOUNDA_ERROR_TEXT` is read: `process.env`, or a Worker's `env`.
   */
  readonly env?: object | undefined;
  readonly config?: Config | undefined;
  /**
   * What a host applies when nothing else says, such as the dev server's `"include"`.
   */
  readonly fallback?: ErrorText | undefined;
  /**
   * Passes over a `BOUNDA_ERROR_TEXT` other than `"omit"` or `"include"` instead of throwing, for
   * code that logs the failure of an app, which is likely that refusal; whatever starts the app
   * should throw.
   */
  readonly ignoreInvalidEnv?: boolean;
}

export interface ResolveErrorTextFunction {
  (args: ResolveErrorTextArgs): ErrorText;
}

const fromEnv = (env: object, ignoreInvalid: boolean | undefined): ErrorText | undefined => {
  const value: unknown = Reflect.get(env, ERROR_TEXT_VARIABLE);
  if (value === "omit" || value === "include") return value;
  if (value === undefined || value === "" || ignoreInvalid) return undefined;
  throw new ConfigurationError(
    `${ERROR_TEXT_VARIABLE} must be "omit" or "include", not ${JSON.stringify(value)}`,
  );
};

/**
 * The rule of `runtime.telemetry.errorText` a host applies, the one precedence every host shares:
 * its own override (`forced`), then `BOUNDA_ERROR_TEXT` in `env`, then the configuration, then
 * the host's `fallback`, then `"omit"`. `boot()`, the CLI, the Durable Object and the Worker of
 * `@bounda-dev/cloudflare` and the `handleError` of `@bounda-dev/react-router` all resolve it
 * here. Throws `ConfigurationError` for a `BOUNDA_ERROR_TEXT` other than `"omit"` or `"include"`
 * unless `ignoreInvalidEnv` is set.
 */
export const resolveErrorText: ResolveErrorTextFunction = ({
  forced,
  env,
  config,
  fallback,
  ignoreInvalidEnv,
}) =>
  forced ??
  (env === undefined ? undefined : fromEnv(env, ignoreInvalidEnv)) ??
  config?.runtime?.telemetry?.errorText ??
  fallback ??
  "omit";

export interface WithErrorTextArgs extends ResolveErrorTextArgs {
  readonly config: Config;
}

export interface WithErrorTextFunction {
  (args: WithErrorTextArgs): Config;
}

/**
 * The configuration with `runtime.telemetry.errorText` set as `resolveErrorText` resolves it, for
 * a host to create the app with.
 */
export const withErrorText: WithErrorTextFunction = (args) => ({
  ...args.config,
  runtime: {
    ...args.config.runtime,
    telemetry: { ...args.config.runtime?.telemetry, errorText: resolveErrorText(args) },
  },
});
