import type {
  ResolvedPoliciesConfig,
  ResolvedProcessesConfig,
  ResolvedRetryConfig,
} from "./types.ts";

/**
 * Retry used by policies and processes when the configuration does not say otherwise.
 */
export const DEFAULT_RETRY: ResolvedRetryConfig = {
  strategy: "exponential",
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

export const DEFAULT_POLICIES: ResolvedPoliciesConfig = {
  retry: DEFAULT_RETRY,
  timeoutMs: 30_000,
  maxChainDepth: 25,
};

export const DEFAULT_PROCESSES: ResolvedProcessesConfig = {
  retry: DEFAULT_RETRY,
  timeoutMs: 7 * 86_400_000,
};

export const DEFAULT_ROOT_DIR: string = "app";
export const DEFAULT_CONCURRENCY_RETRIES: number = 3;
export const DEFAULT_POLL_INTERVAL_MS: number = 100;
export const DEFAULT_IDLE_INTERVAL_MS: number = 30_000;
export const DEFAULT_BATCH_SIZE: number = 100;
export const DEFAULT_PROJECTION_BATCH_TIME_MS: number = 250;
export const DEFAULT_BACKOFF_BASE_DELAY_MS: number = 1_000;
export const DEFAULT_BACKOFF_MAX_DELAY_MS: number = 30_000;
export const DEFAULT_CATCH_UP_TIMEOUT_MS: number = 2_000;
export const DEFAULT_CATCH_UP_POLL_MS: number = 15;
