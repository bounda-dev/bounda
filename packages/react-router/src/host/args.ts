import type { AppRegistry, Consistency, Registry } from "@bounda-dev/core";
import type { ErrorText } from "@bounda-dev/core/config";
import type { ImportModuleFunction } from "@bounda-dev/core/node";
import type { Bounda } from "../create-bounda.ts";

/**
 * What the module the `bounda()` Vite plugin serves hands to `createHost`.
 */
export interface CreateHostArgs<R extends Registry = AppRegistry> {
  /**
   * The project's directory. Defaults to the working directory.
   */
  readonly root?: string;
  readonly registry: R;
  /**
   * Imports `bounda.config.ts`.
   */
  readonly importConfig: ImportModuleFunction;
  /**
   * Imports `app/tenant.ts`, when the project has one.
   */
  readonly importTenant?: ImportModuleFunction | undefined;
  /**
   * Imports `app/actor.ts`, when the project has one.
   */
  readonly importActor?: ImportModuleFunction | undefined;
  readonly consistency: Consistency;
  /**
   * What `runtime.telemetry.errorText` is when the configuration sets none, and what
   * `handleError` follows before the app has booted: the dev server passes `"include"`. Only the
   * Node host applies it: on Cloudflare the app runs in its Durable Object, under the
   * configuration `createBoundaObject` takes and `BOUNDA_ERROR_TEXT` in its `env`, which
   * `.dev.vars` sets in development.
   */
  readonly errorText?: ErrorText;
}

export interface CreateHostFunction {
  <R extends Registry = AppRegistry>(args: CreateHostArgs<R>): Bounda<R>;
}
