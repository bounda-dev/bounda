import type { AdapterDefinition } from "../adapter/adapter-definition.ts";
import type { DurationInput } from "../contracts/duration.ts";
import type { AppPortsConfig } from "../register/index.ts";

/**
 * How failed policy and process handlers and scheduled commands are retried.
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
  /**
   * In `runtime`, also the retry of scheduled commands; an override does not change theirs.
   */
  readonly retry?: RetryConfig;
  /**
   * How long one run of a policy handler may take before it is abandoned. Defaults to 30 seconds,
   * and in `overrides` to `runtime.policies.timeout`.
   */
  readonly timeout?: DurationInput;
  /**
   * How many commands deep a chain of reactions may go before a command is refused with
   * `ChainDepthExceededError`, counted for every command dispatched. Defaults to 25, and in
   * `overrides` to `runtime.policies.maxChainDepth`.
   */
  readonly maxChainDepth?: number;
}

/**
 * Runtime settings for processes.
 */
export interface ProcessesConfig {
  readonly retry?: RetryConfig;
  /**
   * How long an instance lives before its `at-timeout` runs, for processes whose `config` sets no
   * `timeout`. Defaults to 7 days, and in `overrides` to `runtime.processes.timeout`.
   */
  readonly timeout?: DurationInput;
  /**
   * How long one run of a process handler, for an event or a deadline, may take. Past it the run
   * is abandoned: its commands still running stop, later ones are refused with
   * `REACTION_ABANDONED`, and its `signal` aborts. Defaults to 30 seconds, and in `overrides` to
   * `runtime.processes.handlerTimeout`.
   */
  readonly handlerTimeout?: DurationInput;
}

/**
 * Runtime settings for command handlers that one aggregate may override.
 */
export interface AggregateCommandsConfig {
  /**
   * How long one run of a command handler may take. Past it, the dispatch rejects with
   * `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it returns is stored. Each retry
   * after a concurrency conflict gets its own. Defaults to `runtime.commands.timeout`.
   */
  readonly timeout?: DurationInput;
}

/**
 * Runtime settings for the command pipeline.
 */
export interface CommandsRuntimeConfig {
  /**
   * How long one run of a command handler may take. Past it, the dispatch rejects with
   * `HANDLER_TIMEOUT`, the handler's `signal` aborts and nothing it returns is stored. Each retry
   * after a concurrency conflict gets its own. Defaults to 30 seconds.
   */
  readonly timeout?: DurationInput;
  readonly concurrencyRetries?: number;
}

/**
 * Runtime settings for the event dispatcher.
 */
export interface DispatcherConfig {
  /**
   * How long the dispatcher waits between passes when it has to poll, and the pace while it is
   * catching up. Defaults to 100 ms.
   */
  readonly pollInterval?: DurationInput;
  /**
   * With an adapter that pushes notifications, how long an idle dispatcher waits for one before
   * running a pass anyway. Defaults to 30 seconds. Ignored without notifications.
   */
  readonly idleInterval?: DurationInput;
  readonly batchSize?: number;
  /**
   * How long a projection batch keeps its transaction open. Past it, the batch commits what it
   * has projected and the rest is delivered next, so a slow batch never holds SQLite's single
   * writer, or a remote libSQL transaction, for longer. Rebuilds honour it too.
   * Defaults to 250 ms.
   */
  readonly projectionBatchTime?: DurationInput;
  /**
   * How long background passes leave a subscriber alone after a batch of it failed: `baseDelay`
   * after the first failure, doubling with each one after it up to `maxDelay`. The first batch
   * that goes through resets it, and so does another subscriber recovering from failures of its
   * own, which says the database is back. Defaults to 1 second and 30 seconds.
   */
  readonly backoff?: BackoffConfig;
  /**
   * How `catchUpReadModels({ through })`, and read-your-writes with it, waits for the read models
   * a command changed: for at most `timeout`, reading the checkpoint of one another process is
   * busy with every `pollInterval`. Past `timeout` it logs a warning and lets the request read
   * what is there. Defaults to 2 seconds and 15 milliseconds.
   */
  readonly catchUp?: CatchUpConfig;
}

/**
 * The `backoff` of the dispatcher's settings.
 */
export interface BackoffConfig {
  readonly baseDelay?: DurationInput;
  readonly maxDelay?: DurationInput;
}

/**
 * The `catchUp` of the dispatcher's settings.
 */
export interface CatchUpConfig {
  readonly timeout?: DurationInput;
  readonly pollInterval?: DurationInput;
}

/**
 * Settings one aggregate may override.
 */
export interface AggregateOverrides {
  readonly commands?: AggregateCommandsConfig;
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
 * Which implementation each port of each aggregate or read model uses, by module and port in
 * camelCase, with the implementation's file name as the value: `{ order: { notifier: "smtp" } }`. A port with
 * one implementation may be left out; one with several must be named. The generator emits this
 * type for the project, so `defineConfig` checks the names.
 */
export type PortsConfig = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * The `ports` section of the configuration: optional as long as every port of the
 * project has one implementation, required as soon as one has several.
 */
export type PortsSection =
  Record<never, never> extends AppPortsConfig
    ? { readonly ports?: AppPortsConfig }
    : { readonly ports: AppPortsConfig };

/**
 * What `bounda.config.ts` exports.
 */
export type Config = {
  readonly storage: AdapterDefinition;
  readonly readModels?: Readonly<Record<string, AdapterDefinition>>;
  readonly runtime?: RuntimeConfig;
} & PortsSection;

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
  readonly handlerTimeoutMs: number;
}

export interface ResolvedCommandsConfig {
  readonly timeoutMs: number;
}

export interface ResolvedAggregateRuntime {
  readonly commands: ResolvedCommandsConfig;
  readonly policies: ResolvedPoliciesConfig;
  readonly processes: ResolvedProcessesConfig;
}

/**
 * The configuration after validation and defaults: every field present, durations in
 * milliseconds, one resolved runtime block per aggregate through `forAggregate`.
 */
export interface ResolvedConfig {
  readonly storage: AdapterDefinition;
  readonly readModels: Readonly<Record<string, AdapterDefinition>>;
  readonly runtime: {
    readonly role: RuntimeRole;
    readonly commands: ResolvedCommandsConfig & { readonly concurrencyRetries: number };
    readonly policies: ResolvedPoliciesConfig;
    readonly processes: ResolvedProcessesConfig;
    readonly dispatcher: {
      readonly pollIntervalMs: number;
      readonly idleIntervalMs: number;
      readonly batchSize: number;
      readonly projectionBatchTimeMs: number;
      readonly backoff: { readonly baseDelayMs: number; readonly maxDelayMs: number };
      readonly catchUp: { readonly timeoutMs: number; readonly pollIntervalMs: number };
    };
    readonly overrides: Readonly<Record<string, ResolvedAggregateRuntime>>;
  };
  readonly ports: PortsConfig;
  forAggregate(name: string): ResolvedAggregateRuntime;
}
