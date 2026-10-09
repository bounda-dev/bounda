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

export interface PolicyTriggerFromKeyArgs {
  readonly key: string;
  /**
   * The event types of the aggregate the policy reacts to.
   */
  readonly events: readonly string[];
}

export interface PolicyTriggerFromKeyFunction {
  (args: PolicyTriggerFromKeyArgs): string | null;
}

/**
 * The event a policy's file name ends with, after an `-on-`: `send-receipt-on-order-paid`
 * (registry key `sendReceiptOnOrderPaid`) reacts to `OrderPaid`. Of the events that fit, the
 * longest: `put-on-hold-on-payment-failed` reacts to `PaymentFailed`, and
 * `notify-on-add-on-removed` to `AddOnRemoved` rather than `Removed`. The generator types the
 * handler by the same rule.
 */
export const policyTriggerFromKey: PolicyTriggerFromKeyFunction = ({ key, events }) =>
  events
    .filter((event) => key.length > `On${event}`.length && key.endsWith(`On${event}`))
    .reduce<string | null>(
      (longest, event) => (longest === null || event.length > longest.length ? event : longest),
      null,
    );

const declaredTriggers = (
  path: string,
  key: string,
  module: PolicyModule,
  source: string,
  events: readonly string[],
): readonly string[] => {
  if (module.on !== undefined) return typeof module.on === "string" ? [module.on] : module.on;
  const derived = policyTriggerFromKey({ key, events });
  if (derived === null) {
    throw new ConfigurationError(
      `${path}: its name ends with no event of the aggregate "${source}"; name the file "<action>-on-<event>.ts" or export "on"`,
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
  const types = Object.keys(events).map(capitalize);
  const known = new Set<string>(types);
  const triggers = declaredTriggers(path, key, module, source, types);
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
