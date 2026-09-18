import { ConfigurationError } from "../contracts/errors.ts";
import type { CollaboratorImplementations } from "../modules/command.ts";
import type { CommandConfig } from "./types.ts";

export interface SelectCollaboratorsArgs {
  readonly commandName: string;
  readonly implementations: CollaboratorImplementations;
  readonly config: CommandConfig | undefined;
}

export interface SelectCollaboratorsFunction {
  (args: SelectCollaboratorsArgs): Readonly<Record<string, unknown>>;
}

const describe = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(", ");

/**
 * Picks one implementation per collaborator of a command. The configuration's `use` decides; when
 * absent, a collaborator with exactly one implementation uses it. Anything else is a
 * `ConfigurationError` that names the command, the collaborator and the available options.
 */
export const selectCollaborators: SelectCollaboratorsFunction = ({
  commandName,
  implementations,
  config,
}) => {
  const selected = Object.entries(implementations).map(([collaborator, available]) => {
    const options = Object.keys(available);
    const chosen = config?.[collaborator]?.use;
    if (chosen !== undefined) {
      if (!(chosen in available)) {
        throw new ConfigurationError(
          `Command "${commandName}", collaborator "${collaborator}": implementation "${chosen}" not found. Available: ${describe(options)}`,
        );
      }
      return [collaborator, available[chosen]] as const;
    }
    if (options.length === 1) {
      return [collaborator, available[options[0] as string]] as const;
    }
    throw new ConfigurationError(
      `Command "${commandName}", collaborator "${collaborator}": choose an implementation with commands.${commandName}.${collaborator}.use. Available: ${describe(options)}`,
    );
  });
  const unknown = Object.keys(config ?? {}).filter((name) => !(name in implementations));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `Command "${commandName}": configuration names collaborators that do not exist: ${describe(unknown)}`,
    );
  }
  return Object.fromEntries(selected);
};
