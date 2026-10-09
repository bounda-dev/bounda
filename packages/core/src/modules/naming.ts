/**
 * The event or command type name derived from a registry key: `orderPlaced` → `OrderPlaced`.
 */
export type TypeNameOf<Key> = Key extends string ? Capitalize<Key> : never;

export type CapitalizeFunction = <Name extends string>(name: Name) => Capitalize<Name>;

/**
 * Upper-cases the first character.
 */
export const capitalize: CapitalizeFunction = (name) =>
  `${name.charAt(0).toUpperCase()}${name.slice(1)}` as Capitalize<typeof name>;

export interface ToCamelCaseFunction {
  (name: string): string;
}

/**
 * Converts a kebab-case file name to the camelCase key the registry uses: `order-placed` →
 * `orderPlaced`.
 */
export const toCamelCase: ToCamelCaseFunction = (name) =>
  name.replace(/-+([a-zA-Z0-9])/g, (_, character: string) => character.toUpperCase());

export interface PolicyTriggerArgs {
  /**
   * The policy's registry key: its file name in camelCase, prefixed with the aggregate whose
   * events it reacts to when that is another one.
   */
  readonly key: string;
  /**
   * The event types of the aggregate it reacts to, `OrderPaid`.
   */
  readonly events: readonly string[];
}

export interface PolicyTriggerFunction {
  (args: PolicyTriggerArgs): string | null;
}

/**
 * The event a policy reacts to when it exports no `on`: the longest event of the aggregate it
 * reacts to that its key ends with after `On`. `sendReceiptOnOrderPaid` reacts to `OrderPaid`,
 * `putOnHoldOnPaymentFailed` to `PaymentFailed`, and `notifyOnAddOnRemoved` to `AddOnRemoved`
 * rather than `Removed`. `null` when no event fits, and the policy must export `on`. The runtime
 * and `bounda generate` both use it, so a handler is typed with the event it receives.
 */
export const policyTrigger: PolicyTriggerFunction = ({ key, events }) =>
  events
    .filter((event) => key.length > `On${event}`.length && key.endsWith(`On${event}`))
    .reduce<string | null>(
      (longest, event) => (longest === null || event.length > longest.length ? event : longest),
      null,
    );

export interface ToKebabCaseFunction {
  (name: string): string;
}

/**
 * Converts a registry key back to the kebab-case file name it came from: `nextReminder` →
 * `next-reminder`.
 */
export const toKebabCase: ToKebabCaseFunction = (name) =>
  name.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);

/**
 * Flattens an intersection so hovers show one object type instead of `A & B`.
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Turns a union of object types into their intersection.
 */
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
