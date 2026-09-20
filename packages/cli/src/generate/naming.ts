import { capitalize, toCamelCase } from "@bounda-dev/core";

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface IsKebabCaseFunction {
  (name: string): boolean;
}

/**
 * The only shape a module or directory name may have: `order-placed`, `on-timeout`, `v2-report`.
 */
export const isKebabCase: IsKebabCaseFunction = (name) => KEBAB_CASE.test(name);

export interface KeyOfFunction {
  (fileName: string): string;
}

/**
 * The registry key of a file name: `order-placed` → `orderPlaced`.
 */
export const keyOf: KeyOfFunction = (fileName) => toCamelCase(fileName);

export interface TypeNameOfFunction {
  (key: string): string;
}

/**
 * The type name of a key: `orderPlaced` → `OrderPlaced`.
 */
export const typeNameOf: TypeNameOfFunction = (key) => capitalize(key);

export interface JoinKeysFunction {
  (...parts: readonly string[]): string;
}

/**
 * Joins camelCase parts into one identifier: `("orderSummary", "on", "orderPlaced")` →
 * `orderSummaryOnOrderPlaced`.
 */
export const joinKeys: JoinKeysFunction = (...parts) =>
  parts.map((part, index) => (index === 0 ? part : capitalize(part))).join("");

const POLICY_TRIGGER = /^(.+)-on-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface PolicyTriggerOfFunction {
  (fileName: string): string | null;
}

/**
 * The event key a policy file name points at: `send-receipt-on-order-paid` → `orderPaid`; `null`
 * when the name has no `-on-` part.
 */
export const policyTriggerOf: PolicyTriggerOfFunction = (fileName) => {
  const match = POLICY_TRIGGER.exec(fileName);
  return match?.[2] === undefined ? null : toCamelCase(match[2]);
};

const PROCESS_HANDLER = /^on-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface ProcessHandlerEventOfFunction {
  (fileName: string): string | null;
}

/**
 * The event key of a process handler file: `on-order-paid` → `orderPaid`; `null` when the name
 * does not start with `on-`.
 */
export const processHandlerEventOf: ProcessHandlerEventOfFunction = (fileName) => {
  const match = PROCESS_HANDLER.exec(fileName);
  return match?.[1] === undefined ? null : toCamelCase(match[1]);
};

const COLLABORATOR = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;

export interface CollaboratorPartsOfFunction {
  (fileName: string): { readonly name: string; readonly implementation: string } | null;
}

/**
 * Name and implementation of a collaborator file: `audit-log.memory` → `auditLog` / `memory`.
 */
export const collaboratorPartsOf: CollaboratorPartsOfFunction = (fileName) => {
  const match = COLLABORATOR.exec(fileName);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { name: toCamelCase(match[1]), implementation: toCamelCase(match[2]) };
};

export interface UniqueAliasesArgs {
  /**
   * Preferred alias and, for a collision, the owner to prefix it with.
   */
  readonly entries: readonly { readonly alias: string; readonly owner: string }[];
}

export interface UniqueAliasesFunction {
  (args: UniqueAliasesArgs): readonly string[];
}

/**
 * Import aliases for one generated file. A preferred alias that two entries share becomes
 * `<owner><Alias>` for every one of them, so `created` in two aggregates gives `orderCreated`
 * and `customerCreated`.
 */
export const uniqueAliases: UniqueAliasesFunction = ({ entries }) => {
  const counts = new Map<string, number>();
  for (const { alias } of entries) counts.set(alias, (counts.get(alias) ?? 0) + 1);
  return entries.map(({ alias, owner }) =>
    (counts.get(alias) ?? 0) > 1 ? joinKeys(owner, alias) : alias,
  );
};
