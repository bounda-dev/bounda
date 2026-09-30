import { ConfigurationError } from "../contracts/errors.ts";
import type { CollaboratorModules } from "../modules/collaborator.ts";

export interface SelectCollaboratorsArgs {
  readonly aggregate: string;
  readonly implementations: CollaboratorModules;
  /**
   * The aggregate's entry of `collaborators` in the configuration: port to implementation name.
   */
  readonly config: Readonly<Record<string, string>> | undefined;
}

export interface SelectCollaboratorsFunction {
  (args: SelectCollaboratorsArgs): Readonly<Record<string, unknown>>;
}

const describe = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/**
 * Picks one implementation per port of an aggregate: what the configuration names, or the only
 * one there is. Anything else is a `ConfigurationError` that names the aggregate, the port and
 * the available options.
 */
export const selectCollaborators: SelectCollaboratorsFunction = ({
  aggregate,
  implementations,
  config,
}) => {
  const owner = `Aggregate "${aggregate}"`;
  const selected = Object.entries(implementations).map(([port, available]) => {
    const options = Object.keys(available);
    const chosen = config?.[port];
    if (chosen !== undefined) {
      const implementation = available[chosen];
      if (implementation === undefined) {
        throw new ConfigurationError(
          `${owner}, collaborator "${port}": implementation "${chosen}" not found. Available: ${describe(options)}`,
        );
      }
      return [port, implementation.default] as const;
    }
    const [only] = options;
    if (only !== undefined && options.length === 1) {
      return [port, available[only]?.default] as const;
    }
    throw new ConfigurationError(
      `${owner}, collaborator "${port}": choose an implementation with collaborators.${aggregate}.${port}. Available: ${describe(options)}`,
    );
  });
  const unknown = Object.keys(config ?? {}).filter((port) => !(port in implementations));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${owner}: configuration names collaborators that do not exist: ${describe(unknown)}`,
    );
  }
  return Object.fromEntries(selected);
};
