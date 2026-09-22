import type { AdapterDefinition } from "../adapter/adapter-definition.ts";
import type { DurationInput } from "../contracts/duration.ts";

/**
 * How failed policy and process handlers are retried.
 */
export interface RetryConfig {
  readonly strategy: "none" | "fixed" | "linear" | "exponential";
  readonly maxAttempts?: number;
  readonly baseDelay?: DurationInput;
  readonly maxDelay?: DurationInput;
}

/**
 * Runtime settings for policies.
 */
export interface PoliciesConfig {
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
  readonly maxChainDepth?: number;
}

/**
 * Runtime settings for processes. `timeout` is the default for processes that do not declare one.
 */
export interface ProcessesConfig {
  readonly retry?: RetryConfig;
  readonly timeout?: DurationInput;
}

/**
 * Runtime settings for the command pipeline.
 */
export interface CommandsRuntimeConfig {
  readonly concurrencyRetries?: number;
}

/**
 * Runtime settings for the event dispatcher.
 */
export interface DispatcherConfig {
  /**
   * How long the dispatcher waits between passes when it has to poll. Also the pace while it is
   * catching up. Defaults to 100 ms.
   */
  readonly pollInterval?: DurationInput;
  /**
   * With an adapter that pushes notifications, how long the dispatcher waits for one before
   * running a pass anyway, as a safety net. Defaults to 30 seconds. Ignored without notifications.
   */
  readonly idleInterval?: DurationInput;
  readonly batchSize?: number;
}

/**
 * Settings one aggregate may override.
 */
export interface AggregateOverrides {
  readonly policies?: PoliciesConfig;
  readonly processes?: ProcessesConfig;
}

/**
 * Which role this process plays. `web` dispatches commands and answers queries but runs no
 * background work; `worker` runs projections, policies, processes and scheduled commands;
 * `all` does both.
 */
export type RuntimeRole = "web" | "worker" | "all";

/**
 * The `runtime` section of the configuration.
 */
export interface RuntimeConfig {
  readonly role?: RuntimeRole;
  readonly commands?: CommandsRuntimeConfig;
  readonly policies?: PoliciesConfig;
  readonly processes?: ProcessesConfig;
  readonly dispatcher?: DispatcherConfig;
  readonly overrides?: Readonly<Record<string, AggregateOverrides>>;
}

/**
 * Which implementation a command uses for one collaborator: the suffix of the
 * `<collaborator>.<implementation>.ts` file.
 */
export interface CollaboratorSelection {
  readonly use: string;
}

/**
 * Per-command configuration: one entry per collaborator.
 */
export type CommandConfig = Readonly<Record<string, CollaboratorSelection>>;

/**
 * What `bounda.config.ts` exports.
 */
export interface Config {
  readonly rootDir?: string;
  readonly storage: AdapterDefinition;
  readonly readModels?: Readonly<Record<string, AdapterDefinition>>;
  readonly runtime?: RuntimeConfig;
  readonly commands?: Readonly<Record<string, CommandConfig>>;
}

/**
 * Retry settings with every value present and durations in milliseconds.
 */
export interface ResolvedRetryConfig {
  readonly strategy: "none" | "fixed" | "linear" | "exponential";
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ResolvedPoliciesConfig {
  readonly retry: ResolvedRetryConfig;
  readonly timeoutMs: number;
  readonly maxChainDepth: number;
}

export interface ResolvedProcessesConfig {
  readonly retry: ResolvedRetryConfig;
  readonly timeoutMs: number;
}

export interface ResolvedAggregateRuntime {
  readonly policies: ResolvedPoliciesConfig;
  readonly processes: ResolvedProcessesConfig;
}

/**
 * The configuration after validation and defaults: every field present, durations in
 * milliseconds, one resolved runtime block per aggregate through `forAggregate`.
 */
export interface ResolvedConfig {
  readonly rootDir: string;
  readonly storage: AdapterDefinition;
  readonly readModels: Readonly<Record<string, AdapterDefinition>>;
  readonly runtime: {
    readonly role: RuntimeRole;
    readonly commands: { readonly concurrencyRetries: number };
    readonly policies: ResolvedPoliciesConfig;
    readonly processes: ResolvedProcessesConfig;
    readonly dispatcher: {
      readonly pollIntervalMs: number;
      readonly idleIntervalMs: number;
      readonly batchSize: number;
    };
    readonly overrides: Readonly<Record<string, ResolvedAggregateRuntime>>;
  };
  readonly commands: Readonly<Record<string, CommandConfig>>;
  forAggregate(name: string): ResolvedAggregateRuntime;
}
