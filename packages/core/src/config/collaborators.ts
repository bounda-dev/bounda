import { ConfigurationError } from "../contracts/errors.ts";
import type { CollaboratorImplementations } from "../modules/command.ts";
import type { CollaboratorsConfig } from "./types.ts";

export interface SelectCollaboratorsArgs {
  /**
   * Who the collaborators belong to, as errors name it: `Command "placeOrder"`.
   */
  readonly owner: string;
  /**
   * Where the owner's collaborators are configured: `commands.placeOrder`.
   */
  readonly path: string;
  readonly implementations: CollaboratorImplementations;
  readonly config: CollaboratorsConfig | undefined;
}

export interface SelectCollaboratorsFunction {
  (args: SelectCollaboratorsArgs): Readonly<Record<string, unknown>>;
}

const describe = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/**
 * Picks one implementation per collaborator of a command, policy or process. The configuration's
 * `use` decides; when absent, a collaborator with exactly one implementation uses it. Anything
 * else is a `ConfigurationError` that names the owner, the collaborator and the available options.
 */
export const selectCollaborators: SelectCollaboratorsFunction = ({
  owner,
  path,
  implementations,
  config,
}) => {
  const selected = Object.entries(implementations).map(([collaborator, available]) => {
    const options = Object.keys(available);
    const chosen = config?.[collaborator]?.use;
    if (chosen !== undefined) {
      if (!(chosen in available)) {
        throw new ConfigurationError(
          `${owner}, collaborator "${collaborator}": implementation "${chosen}" not found. Available: ${describe(options)}`,
        );
      }
      return [collaborator, available[chosen]] as const;
    }
    if (options.length === 1) {
      return [collaborator, available[options[0] as string]] as const;
    }
    throw new ConfigurationError(
      `${owner}, collaborator "${collaborator}": choose an implementation with ${path}.${collaborator}.use. Available: ${describe(options)}`,
    );
  });
  const unknown = Object.keys(config ?? {}).filter((name) => !(name in implementations));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${owner}: configuration names collaborators that do not exist: ${describe(unknown)}`,
    );
  }
  return Object.fromEntries(selected);
};
