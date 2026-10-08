import { ConfigurationError } from "../contracts/errors.ts";
import type { ImplementationModule, PortModules } from "../modules/port.ts";

/**
 * The module whose ports are chosen: an aggregate or a read model, as the errors name it.
 */
export interface PortOwner {
  readonly kind: "aggregate" | "read model";
  readonly name: string;
}

export interface DescribeOwnerFunction {
  (owner: PortOwner): string;
}

export const describeOwner: DescribeOwnerFunction = ({ kind, name }) =>
  `${kind === "aggregate" ? "Aggregate" : "Read model"} "${name}"`;

export interface SelectImplementationsArgs {
  readonly owner: PortOwner;
  readonly implementations: PortModules;
  /**
   * The owner's entry of `ports` in the configuration: port to implementation name.
   */
  readonly config: Readonly<Record<string, string>> | undefined;
}

export interface SelectImplementationsFunction {
  (args: SelectImplementationsArgs): Readonly<Record<string, ImplementationModule<unknown>>>;
}

export interface DescribeNamesFunction {
  (names: readonly string[]): string;
}

export const describeNames: DescribeNamesFunction = (names) =>
  names.map((name) => `"${name}"`).join(", ");

export interface ImplementationNotFoundArgs {
  readonly owner: string;
  readonly port: string;
  readonly chosen: string;
  readonly options: readonly string[];
}

export interface ImplementationNotFoundFunction {
  (args: ImplementationNotFoundArgs): ConfigurationError;
}

export const implementationNotFound: ImplementationNotFoundFunction = ({
  owner,
  port,
  chosen,
  options,
}) =>
  new ConfigurationError(
    `${owner}, port "${port}": implementation "${chosen}" not found. Available: ${describeNames(options)}`,
  );

/**
 * Picks one implementation module per port of an aggregate or a read model: what the
 * configuration names, or the only one there is. Anything else is a `ConfigurationError` that
 * names the owner, the port and the available options.
 */
export const selectImplementations: SelectImplementationsFunction = ({
  owner,
  implementations,
  config,
}) => {
  const label = describeOwner(owner);
  const selected = Object.entries(implementations).map(([port, available]) => {
    const options = Object.keys(available);
    const chosen = config?.[port];
    if (chosen !== undefined) {
      const implementation = Object.hasOwn(available, chosen) ? available[chosen] : undefined;
      if (implementation === undefined)
        throw implementationNotFound({ owner: label, port, chosen, options });
      return [port, implementation] as const;
    }
    const [only, ...others] = Object.values(available);
    if (only !== undefined && others.length === 0) return [port, only] as const;
    throw new ConfigurationError(
      `${label}, port "${port}": choose an implementation with ports.${owner.name}.${port}. Available: ${describeNames(options)}`,
    );
  });
  const unknown = Object.keys(config ?? {}).filter((port) => !Object.hasOwn(implementations, port));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${label}: configuration names ports that do not exist: ${describeNames(unknown)}`,
    );
  }
  return Object.fromEntries(selected);
};
