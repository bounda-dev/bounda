import type {
  ResolvedCommandsConfig,
  ResolvedPoliciesConfig,
  ResolvedProcessesConfig,
  ResolvedRetryConfig,
} from "./types.ts";

export const DEFAULT_RETRY: ResolvedRetryConfig = {
  strategy: "exponential",
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export const DEFAULT_COMMANDS: ResolvedCommandsConfig = {
  timeoutMs: 30_000,
};

export const DEFAULT_POLICIES: ResolvedPoliciesConfig = {
  retry: DEFAULT_RETRY,
  timeoutMs: 30_000,
  maxChainDepth: 25,
};

export const DEFAULT_PROCESSES: ResolvedProcessesConfig = {
  retry: DEFAULT_RETRY,
  timeoutMs: 7 * 86_400_000,
  handlerTimeoutMs: 30_000,
};

export const DEFAULT_CONCURRENCY_RETRIES: number = 3;
export const DEFAULT_IDEMPOTENCY_KEY_LIFETIME_MS: number = 86_400_000;
export const DEFAULT_POLL_INTERVAL_MS: number = 100;
export const DEFAULT_IDLE_INTERVAL_MS: number = 30_000;
export const DEFAULT_BATCH_SIZE: number = 100;
export const DEFAULT_PROJECTION_BATCH_TIME_MS: number = 250;
export const DEFAULT_BACKOFF_BASE_DELAY_MS: number = 1_000;
export const DEFAULT_BACKOFF_MAX_DELAY_MS: number = 30_000;
export const DEFAULT_CATCH_UP_TIMEOUT_MS: number = 2_000;
export const DEFAULT_CATCH_UP_POLL_MS: number = 15;
/**
 * The share of the loads from a snapshot checked against the whole stream when `snapshot.verify`
 * is left out.
 */
export const DEFAULT_SNAPSHOT_VERIFY: number = 0.01;
/**
 * The `snapshot.version` of an aggregate whose configuration sets none.
 */
export const DEFAULT_SNAPSHOT_VERSION: number = 1;
