import { ConfigurationError } from "../../contracts/errors.ts";
import type { PolicyModule } from "../../modules/policy.ts";
import type { Registry } from "../../modules/registry.ts";

/**
 * A compiled policy: which aggregate it belongs to, which event types trigger it, and its handler.
 */
export interface PolicyRuntime {
  readonly name: string;
  readonly aggregate: string;
  readonly on: readonly string[];
  readonly handler: (args: Record<string, unknown>) => unknown;
}

export interface PoliciesRuntime {
  readonly all: readonly PolicyRuntime[];
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

const triggersOf = (aggregate: string, key: string, module: PolicyModule): readonly string[] => {
  if (module.on !== undefined) return typeof module.on === "string" ? [module.on] : module.on;
  const derived = policyTriggerFromKey(key);
  if (derived === null) {
    throw new ConfigurationError(
      `aggregates.${aggregate}.policies.${key}: name the file "<action>-on-<event>.ts" or export "on"`,
    );
  }
  return [derived];
};

export interface BuildPoliciesArgs {
  readonly registry: Registry;
}

export interface BuildPoliciesFunction {
  (args: BuildPoliciesArgs): PoliciesRuntime;
}

/**
 * Compiles every policy of the registry and indexes them by the event types they react to.
 */
export const buildPolicies: BuildPoliciesFunction = ({ registry }) => {
  const all = Object.entries(registry.aggregates).flatMap(([aggregate, entry]) =>
    Object.entries(entry.policies).map(
      ([key, module]): PolicyRuntime => ({
        name: `${aggregate}.${key}`,
        aggregate,
        on: triggersOf(aggregate, key, module),
        handler: module.handler as PolicyRuntime["handler"],
      }),
    ),
  );
  const byEvent: Record<string, PolicyRuntime[]> = {};
  for (const policy of all) {
    for (const type of policy.on) byEvent[type] = [...(byEvent[type] ?? []), policy];
  }
  return { all, byEvent };
};
