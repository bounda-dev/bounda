import { describeNames, implementationNotFound } from "../../config/collaborators.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { CollaboratorModules, ImplementationModule } from "../../modules/collaborator.ts";

/**
 * What a port gets: an implementation module to build, a test's double to hand out as it is, or
 * nothing, with the error that reading it throws, built on each read so its stack shows the reader.
 */
export type PortChoice =
  | { readonly module: ImplementationModule<unknown> }
  | { readonly double: unknown }
  | { readonly missing: () => ConfigurationError };

export interface SelectTestCollaboratorsArgs {
  readonly aggregate: string;
  readonly implementations: CollaboratorModules;
  /**
   * The aggregate's entry of `createTestApp`'s `collaborators`: port to a file name or a double.
   */
  readonly chosen: Readonly<Record<string, unknown>> | undefined;
}

export interface SelectTestCollaboratorsFunction {
  (args: SelectTestCollaboratorsArgs): Readonly<Record<string, PortChoice>>;
}

/**
 * Unlike the app's configuration, a port the test leaves out gets no implementation even when it
 * has only one, so a test never reaches a real provider it did not ask for.
 */
export const selectTestCollaborators: SelectTestCollaboratorsFunction = ({
  aggregate,
  implementations,
  chosen = {},
}) => {
  const owner = `Aggregate "${aggregate}"`;
  const unknown = Object.keys(chosen).filter((port) => !Object.hasOwn(implementations, port));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${owner}: createTestApp names collaborators that do not exist: ${describeNames(unknown)}`,
    );
  }
  return Object.fromEntries(
    Object.entries(implementations).map(([port, available]): [string, PortChoice] => {
      const options = Object.keys(available);
      const given = chosen[port];
      if (given === undefined) {
        return [
          port,
          {
            missing: () =>
              new ConfigurationError(
                `${owner}, collaborator "${port}": this test app was given none. Pass createTestApp collaborators: { ${aggregate}: { ${port}: <double> } }, or one of ${describeNames(options)}.`,
              ),
          },
        ];
      }
      if (typeof given !== "string") return [port, { double: given }];
      const module = Object.hasOwn(available, given) ? available[given] : undefined;
      if (module === undefined)
        throw implementationNotFound({ owner, port, chosen: given, options });
      return [port, { module }];
    }),
  );
};
