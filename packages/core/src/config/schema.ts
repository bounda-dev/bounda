import { z } from "zod";
import { isAdapterDefinition } from "../adapter/adapter-definition.ts";
import { parseDuration } from "../contracts/duration.ts";
import { ConfigurationError } from "../contracts/errors.ts";
import {
  DEFAULT_BACKOFF_BASE_DELAY_MS,
  DEFAULT_BACKOFF_MAX_DELAY_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CATCH_UP_POLL_MS,
  DEFAULT_CATCH_UP_TIMEOUT_MS,
  DEFAULT_COMMANDS,
  DEFAULT_CONCURRENCY_RETRIES,
  DEFAULT_IDLE_INTERVAL_MS,
  DEFAULT_POLICIES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_PROCESSES,
  DEFAULT_PROJECTION_BATCH_TIME_MS,
} from "./defaults.ts";
import type {
  Config,
  ResolvedAggregateRuntime,
  ResolvedCommandsConfig,
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

const timeout = duration.refine((milliseconds) => milliseconds > 0, {
  message: "Expected a duration longer than 0",
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

const commands = z.strictObject({
  timeout: timeout.optional(),
});

const policies = z.strictObject({
  retry: retry.optional(),
  timeout: timeout.optional(),
  maxChainDepth: z.int().min(1).optional(),
});

const processes = z.strictObject({
  retry: retry.optional(),
  timeout: duration.optional(),
  handlerTimeout: timeout.optional(),
});

const overrides = z.strictObject({
  commands: commands.optional(),
  policies: policies.optional(),
  processes: processes.optional(),
});

const runtime = z.strictObject({
  role: z.enum(["web", "worker", "all"]).optional(),
  commands: commands.extend({ concurrencyRetries: z.int().min(0).optional() }).optional(),
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
      catchUp: z
        .strictObject({ timeout: duration.optional(), pollInterval: duration.optional() })
        .optional(),
    })
    .optional(),
  overrides: z.record(z.string(), overrides).optional(),
});

const ports = z.record(z.string(), z.record(z.string(), z.string().min(1)));

const configSchema = z.strictObject({
  storage: adapter,
  readModels: z.record(z.string(), adapter).optional(),
  runtime: runtime.optional(),
  ports: ports.optional(),
});

type ParsedRetry = z.output<typeof retry>;
type ParsedCommands = z.output<typeof commands>;
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

const resolveCommands = (
  parsed: ParsedCommands | undefined,
  base: ResolvedCommandsConfig,
): ResolvedCommandsConfig => ({
  timeoutMs: parsed?.timeout ?? base.timeoutMs,
});

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
  handlerTimeoutMs: parsed?.handlerTimeout ?? base.handlerTimeoutMs,
});

const formatIssues = (issues: readonly z.core.$ZodIssue[]): string =>
  issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");

export interface ResolveConfigFunction {
  (config: Config): ResolvedConfig;
}

export const resolveConfig: ResolveConfigFunction = (config) => {
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigurationError(`Invalid bounda.config.ts:\n${formatIssues(result.error.issues)}`);
  }
  const parsed = result.data;
  const baseCommands = resolveCommands(parsed.runtime?.commands, DEFAULT_COMMANDS);
  const basePolicies = resolvePolicies(parsed.runtime?.policies, DEFAULT_POLICIES);
  const baseProcesses = resolveProcesses(parsed.runtime?.processes, DEFAULT_PROCESSES);
  const defaultsForAggregate: ResolvedAggregateRuntime = {
    commands: baseCommands,
    policies: basePolicies,
    processes: baseProcesses,
  };
  const resolvedOverrides = Object.fromEntries(
    Object.entries(parsed.runtime?.overrides ?? {}).map(([aggregate, override]) => [
      aggregate,
      {
        commands: resolveCommands(override.commands, baseCommands),
        policies: resolvePolicies(override.policies, basePolicies),
        processes: resolveProcesses(override.processes, baseProcesses),
      } satisfies ResolvedAggregateRuntime,
    ]),
  );

  return {
    storage: parsed.storage,
    readModels: parsed.readModels ?? {},
    runtime: {
      role: parsed.runtime?.role ?? "all",
      commands: {
        ...baseCommands,
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
        catchUp: {
          timeoutMs: parsed.runtime?.dispatcher?.catchUp?.timeout ?? DEFAULT_CATCH_UP_TIMEOUT_MS,
          pollIntervalMs:
            parsed.runtime?.dispatcher?.catchUp?.pollInterval ?? DEFAULT_CATCH_UP_POLL_MS,
        },
      },
      overrides: resolvedOverrides,
    },
    ports: parsed.ports ?? {},
    forAggregate: (name) => resolvedOverrides[name] ?? defaultsForAggregate,
  };
};
