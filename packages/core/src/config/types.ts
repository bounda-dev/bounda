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
  /**
   * How long a projection batch keeps its transaction open. Past it, the batch commits what it
   * has projected so far and the rest of it is delivered next, so a slow batch never holds
   * SQLite's single writer, or a remote libSQL transaction, for longer. Rebuilds honour it too.
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
   * busy with every `pollInterval`. Past `timeout` it gives up, logs a warning and lets the
   * request read what is there. Defaults to 2 seconds and 15 milliseconds.
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
 * Which implementation a command, policy or process uses for one collaborator: the suffix of the
 * `<collaborator>.<implementation>.ts` file.
 */
export interface CollaboratorSelection {
  readonly use: string;
}

/**
 * The collaborators of one command, policy or process: one entry per collaborator.
 */
export type CollaboratorsConfig = Readonly<Record<string, CollaboratorSelection>>;

/**
 * Collaborators of policies or processes, keyed by aggregate and then by the policy or process
 * key: `{ order: { sendReceiptOnOrderPaid: { mailer: { use: "memory" } } } }`.
 */
export type ReactionsConfig = Readonly<
  Record<string, Readonly<Record<string, CollaboratorsConfig>>>
>;

/**
 * What `bounda.config.ts` exports.
 */
export interface Config {
  readonly rootDir?: string;
  readonly storage: AdapterDefinition;
  readonly readModels?: Readonly<Record<string, AdapterDefinition>>;
  readonly runtime?: RuntimeConfig;
  readonly commands?: Readonly<Record<string, CollaboratorsConfig>>;
  readonly policies?: ReactionsConfig;
  readonly processes?: ReactionsConfig;
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
      readonly projectionBatchTimeMs: number;
      readonly backoff: { readonly baseDelayMs: number; readonly maxDelayMs: number };
      readonly catchUp: { readonly timeoutMs: number; readonly pollIntervalMs: number };
    };
    readonly overrides: Readonly<Record<string, ResolvedAggregateRuntime>>;
  };
  readonly commands: Readonly<Record<string, CollaboratorsConfig>>;
  readonly policies: ReactionsConfig;
  readonly processes: ReactionsConfig;
  forAggregate(name: string): ResolvedAggregateRuntime;
}
