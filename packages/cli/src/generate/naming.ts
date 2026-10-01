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

export const keyOf: KeyOfFunction = (fileName) => toCamelCase(fileName);

export interface TypeNameOfFunction {
  (key: string): string;
}

export const typeNameOf: TypeNameOfFunction = (key) => capitalize(key);

export interface JoinKeysFunction {
  (...parts: readonly string[]): string;
}

export const joinKeys: JoinKeysFunction = (...parts) =>
  parts.map((part, index) => (index === 0 ? part : capitalize(part))).join("");

const POLICY_TRIGGER = /^(.+)-on-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface PolicyTriggerOfFunction {
  (fileName: string): string | null;
}

/**
 * Takes the event after the last `-on-`: `send-receipt-on-order-paid` → `orderPaid`.
 */
export const policyTriggerOf: PolicyTriggerOfFunction = (fileName) => {
  const match = POLICY_TRIGGER.exec(fileName);
  return match?.[2] === undefined ? null : toCamelCase(match[2]);
};

const PROCESS_HANDLER = /^on-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface ProcessHandlerEventOfFunction {
  (fileName: string): string | null;
}

export const processHandlerEventOf: ProcessHandlerEventOfFunction = (fileName) => {
  const match = PROCESS_HANDLER.exec(fileName);
  return match?.[1] === undefined ? null : toCamelCase(match[1]);
};

const PROCESS_DEADLINE = /^at-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface ProcessDeadlineOfFunction {
  (fileName: string): string | null;
}

export const processDeadlineOf: ProcessDeadlineOfFunction = (fileName) => {
  const match = PROCESS_DEADLINE.exec(fileName);
  return match?.[1] === undefined ? null : toCamelCase(match[1]);
};

export interface UniqueAliasesArgs {
  readonly entries: readonly { readonly alias: string; readonly owner: string }[];
}

export interface UniqueAliasesFunction {
  (args: UniqueAliasesArgs): readonly string[];
}

/**
 * An alias two entries share is prefixed with the owner in every one of them, not only the
 * second: `created` in two aggregates gives `orderCreated` and `customerCreated`.
 */
export const uniqueAliases: UniqueAliasesFunction = ({ entries }) => {
  const counts = new Map<string, number>();
  for (const { alias } of entries) counts.set(alias, (counts.get(alias) ?? 0) + 1);
  return entries.map(({ alias, owner }) =>
    (counts.get(alias) ?? 0) > 1 ? joinKeys(owner, alias) : alias,
  );
};
