import { z } from "zod";
import { isAdapterDefinition } from "../adapter/adapter-definition.ts";
import { parseDuration } from "../contracts/duration.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import {
  DEFAULT_BACKOFF_BASE_DELAY_MS,
  DEFAULT_BACKOFF_MAX_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY_RETRIES,
  DEFAULT_IDLE_INTERVAL_MS,
  DEFAULT_POLICIES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROCESSES,
  DEFAULT_PROJECTION_BATCH_TIME_MS,
  DEFAULT_ROOT_DIR,
} from "./defaults.ts";
import type {
  Config,
  ResolvedAggregateRuntime,
  ResolvedConfig,
  ResolvedPoliciesConfig,
  ResolvedProcessesConfig,
  ResolvedRetryConfig,
} from "./types.ts";

const duration = z.union([z.number(), z.string()]).transform((value, context) => {
  try {
    return parseDuration(value);
  } catch (error) {
    context.addIssue({ code: "custom", message: (error as Error).message });
    return z.NEVER;
  }
});

const adapter = z.custom<Config["storage"]>(isAdapterDefinition, {
  message: "Expected an adapter definition such as sqlite({ ... })",
});

const retry = z.strictObject({
  strategy: z.enum(["none", "fixed", "linear", "exponential"]),
  maxAttempts: z.int().min(1).optional(),
  baseDelay: duration.optional(),
  maxDelay: duration.optional(),
});

const policies = z.strictObject({
  retry: retry.optional(),
  timeout: duration.optional(),
  maxChainDepth: z.int().min(1).optional(),
});

const processes = z.strictObject({
  retry: retry.optional(),
  timeout: duration.optional(),
});

const overrides = z.strictObject({
  policies: policies.optional(),
  processes: processes.optional(),
});

const runtime = z.strictObject({
  role: z.enum(["web", "worker", "all"]).optional(),
  commands: z.strictObject({ concurrencyRetries: z.int().min(0).optional() }).optional(),
  policies: policies.optional(),
  processes: processes.optional(),
  dispatcher: z
    .strictObject({
      pollInterval: duration.optional(),
      idleInterval: duration.optional(),
      batchSize: z.int().min(1).optional(),
      projectionBatchTime: duration.optional(),
      backoff: z
        .strictObject({ baseDelay: duration.optional(), maxDelay: duration.optional() })
        .optional(),
    })
    .optional(),
  overrides: z.record(z.string(), overrides).optional(),
});

const commandConfig = z.record(z.string(), z.strictObject({ use: z.string().min(1) }));

const configSchema = z.strictObject({
  rootDir: z.string().min(1).optional(),
  storage: adapter,
  readModels: z.record(z.string(), adapter).optional(),
  runtime: runtime.optional(),
  commands: z.record(z.string(), commandConfig).optional(),
});

type ParsedRetry = z.output<typeof retry>;
type ParsedPolicies = z.output<typeof policies>;
type ParsedProcesses = z.output<typeof processes>;

const resolveRetry = (
  parsed: ParsedRetry | undefined,
  base: ResolvedRetryConfig,
): ResolvedRetryConfig =>
  parsed === undefined
    ? base
    : {
        strategy: parsed.strategy,
        maxAttempts: parsed.maxAttempts ?? base.maxAttempts,
        baseDelayMs: parsed.baseDelay ?? base.baseDelayMs,
        maxDelayMs: parsed.maxDelay ?? base.maxDelayMs,
      };

const resolvePolicies = (
  parsed: ParsedPolicies | undefined,
  base: ResolvedPoliciesConfig,
): ResolvedPoliciesConfig => ({
  retry: resolveRetry(parsed?.retry, base.retry),
  timeoutMs: parsed?.timeout ?? base.timeoutMs,
  maxChainDepth: parsed?.maxChainDepth ?? base.maxChainDepth,
});

const resolveProcesses = (
  parsed: ParsedProcesses | undefined,
  base: ResolvedProcessesConfig,
): ResolvedProcessesConfig => ({
  retry: resolveRetry(parsed?.retry, base.retry),
  timeoutMs: parsed?.timeout ?? base.timeoutMs,
});

const formatIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");

export interface ResolveConfigFunction {
  (config: Config): ResolvedConfig;
}

/**
 * Validates `bounda.config.ts` and fills in defaults. Throws `ConfigurationError` listing every
 * problem with its path. Durations come back in milliseconds.
 */
export const resolveConfig: ResolveConfigFunction = (config) => {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigurationError(`Invalid bounda.config.ts:\n${formatIssues(result.error.issues)}`);
  }
  const parsed = result.data;
  const basePolicies = resolvePolicies(parsed.runtime?.policies, DEFAULT_POLICIES);
  const baseProcesses = resolveProcesses(parsed.runtime?.processes, DEFAULT_PROCESSES);
  const defaultsForAggregate: ResolvedAggregateRuntime = {
    policies: basePolicies,
    processes: baseProcesses,
  };
  const resolvedOverrides = Object.fromEntries(
    Object.entries(parsed.runtime?.overrides ?? {}).map(([aggregate, override]) => [
      aggregate,
      {
        policies: resolvePolicies(override.policies, basePolicies),
        processes: resolveProcesses(override.processes, baseProcesses),
      } satisfies ResolvedAggregateRuntime,
    ]),
  );

  return {
    rootDir: parsed.rootDir ?? DEFAULT_ROOT_DIR,
    storage: parsed.storage,
    readModels: parsed.readModels ?? {},
    runtime: {
      role: parsed.runtime?.role ?? "all",
      commands: {
        concurrencyRetries:
          parsed.runtime?.commands?.concurrencyRetries ?? DEFAULT_CONCURRENCY_RETRIES,
      },
      policies: basePolicies,
      processes: baseProcesses,
      dispatcher: {
        pollIntervalMs: parsed.runtime?.dispatcher?.pollInterval ?? DEFAULT_POLL_INTERVAL_MS,
        idleIntervalMs: parsed.runtime?.dispatcher?.idleInterval ?? DEFAULT_IDLE_INTERVAL_MS,
        batchSize: parsed.runtime?.dispatcher?.batchSize ?? DEFAULT_BATCH_SIZE,
        projectionBatchTimeMs:
          parsed.runtime?.dispatcher?.projectionBatchTime ?? DEFAULT_PROJECTION_BATCH_TIME_MS,
        backoff: {
          baseDelayMs:
            parsed.runtime?.dispatcher?.backoff?.baseDelay ?? DEFAULT_BACKOFF_BASE_DELAY_MS,
          maxDelayMs: parsed.runtime?.dispatcher?.backoff?.maxDelay ?? DEFAULT_BACKOFF_MAX_DELAY_MS,
        },
      },
      overrides: resolvedOverrides,
    },
    commands: parsed.commands ?? {},
    forAggregate: (name) => resolvedOverrides[name] ?? defaultsForAggregate,
  };
};
