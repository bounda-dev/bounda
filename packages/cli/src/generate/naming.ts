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

export interface PolicyTriggerOfArgs {
  readonly fileName: string;
  /**
   * The event keys of the aggregate the policy reacts to.
   */
  readonly events: readonly string[];
}

export interface PolicyTriggerOfFunction {
  (args: PolicyTriggerOfArgs): string | null;
}

/**
 * The longest event the file name ends with after an `-on-`: `send-receipt-on-order-paid` →
 * `orderPaid`, `put-on-hold-on-payment-failed` → `paymentFailed`. Core derives the trigger by the
 * same rule, so the handler is typed with the event it receives.
 */
export const policyTriggerOf: PolicyTriggerOfFunction = ({ fileName, events }) => {
  const key = toCamelCase(fileName);
  return events
    .map((event) => [event, `On${capitalize(event)}`] as const)
    .filter(([, suffix]) => key.length > suffix.length && key.endsWith(suffix))
    .reduce<string | null>(
      (longest, [event]) => (longest === null || event.length > longest.length ? event : longest),
      null,
    );
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
