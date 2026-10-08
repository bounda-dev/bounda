import { parseDuration } from "../../contracts/duration.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import { capitalize } from "../../modules/naming.ts";
import type { PolicyModule } from "../../modules/policy.ts";
import type { Registry } from "../../modules/registry.ts";
import type { AggregatesRuntime } from "../aggregate/runtime.ts";
import { qualifiedEventType } from "../shared/qualified-event.ts";

export interface PolicyRuntime {
  readonly name: string;
  readonly aggregate: string;
  /**
   * The aggregate whose events the policy reacts to: its own, or the one of its folder.
   */
  readonly source: string;
  /**
   * Event types of `source`, unqualified: `OrderPaid`.
   */
  readonly on: readonly string[];
  readonly handler: (args: Record<string, unknown>) => unknown;
  readonly ports: Readonly<Record<string, unknown>>;
  /**
   * `null` for a policy that runs as soon as its event is delivered.
   */
  readonly delayMs: number | null;
}

export interface PoliciesRuntime {
  readonly all: readonly PolicyRuntime[];
  readonly byName: Readonly<Record<string, PolicyRuntime>>;
  /**
   * Keyed by qualified event type, `order.OrderPlaced`.
   */
  readonly byEvent: Readonly<Record<string, readonly PolicyRuntime[]>>;
}

const TRIGGER_SUFFIX = /On([A-Z][A-Za-z0-9]*)$/;

export interface PolicyTriggerFromKeyFunction {
  (key: string): string | null;
}

/**
 * Derives the triggering event type from a policy's file name: `send-receipt-on-order-paid`
 * (registry key `sendReceiptOnOrderPaid`) reacts to `OrderPaid`.
 */
export const policyTriggerFromKey: PolicyTriggerFromKeyFunction = (key) =>
  TRIGGER_SUFFIX.exec(key)?.[1] ?? null;

const declaredTriggers = (
  aggregate: string,
  key: string,
  module: PolicyModule,
): readonly string[] => {
  if (module.on !== undefined) return typeof module.on === "string" ? [module.on] : module.on;
  const derived = policyTriggerFromKey(key);
  if (derived === null) {
    throw new ConfigurationError(
      `aggregates.${aggregate}.policies.${key}: name the file "<action>-on-<event>.ts" or export "on"`,
    );
  }
  return [derived];
};

const triggersOf = (
  registry: Registry,
  aggregate: string,
  key: string,
  module: PolicyModule,
  source: string,
): readonly string[] => {
  const path = `aggregates.${aggregate}.policies.${key}`;
  const events = registry.aggregates[source]?.events;
  if (events === undefined) {
    throw new ConfigurationError(
      `${path}: there is no aggregate "${source}" whose events to react to`,
    );
  }
  const known = new Set<string>(Object.keys(events).map(capitalize));
  const triggers = declaredTriggers(aggregate, key, module);
  for (const trigger of triggers) {
    if (!known.has(trigger)) {
      throw new ConfigurationError(
        `${path}: "${trigger}" is not an event of the aggregate "${source}"`,
      );
    }
  }
  return triggers;
};

const delayOf = (aggregate: string, key: string, module: PolicyModule): number | null => {
  if (module.delay === undefined) return null;
  try {
    return parseDuration(module.delay);
  } catch {
    throw new ConfigurationError(
      `aggregates.${aggregate}.policies.${key}: delay ${JSON.stringify(module.delay)} is not a duration such as "30s", "5m" or 60000`,
    );
  }
};

export interface BuildPoliciesArgs {
  readonly registry: Registry;
  readonly aggregates: AggregatesRuntime;
}

export interface BuildPoliciesFunction {
  (args: BuildPoliciesArgs): PoliciesRuntime;
}

/**
 * A policy whose trigger is not an event of the aggregate it listens to is a configuration error:
 * it would never run.
 */
export const buildPolicies: BuildPoliciesFunction = ({ registry, aggregates }) => {
  const all = Object.entries(registry.aggregates).flatMap(([aggregate, entry]) =>
    Object.entries(entry.policies).map(
      ([key, policy]): PolicyRuntime => ({
        name: `${aggregate}.${key}`,
        aggregate,
        source: policy.source ?? aggregate,
        on: triggersOf(registry, aggregate, key, policy.module, policy.source ?? aggregate),
        handler: policy.module.handler as PolicyRuntime["handler"],
        delayMs: delayOf(aggregate, key, policy.module),
        ports: aggregates.byName[aggregate]?.ports ?? {},
      }),
    ),
  );
  const byEvent: Record<string, PolicyRuntime[]> = {};
  for (const policy of all) {
    for (const type of policy.on) {
      const qualified = qualifiedEventType(policy.source, type);
      byEvent[qualified] = [...(byEvent[qualified] ?? []), policy];
    }
  }
  return {
    all,
    byName: Object.fromEntries(all.map((policy) => [policy.name, policy])),
    byEvent,
  };
};
