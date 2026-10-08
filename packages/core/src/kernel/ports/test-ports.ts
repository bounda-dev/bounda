import {
  describeNames,
  describeOwner,
  implementationNotFound,
  type PortOwner,
} from "../../config/ports.ts";
import { ConfigurationError } from "../../contracts/errors.ts";
import type { ImplementationModule, PortModules } from "../../modules/port.ts";

/**
 * What a port gets: an implementation module to build, a test's double to hand out as it is, or
 * nothing, with the error that reading it throws, built on each read so its stack shows the reader.
 */
export type PortChoice =
  | { readonly module: ImplementationModule<unknown> }
  | { readonly double: unknown }
  | { readonly missing: () => ConfigurationError };

export interface SelectTestImplementationsArgs {
  readonly owner: PortOwner;
  readonly implementations: PortModules;
  /**
   * The owner's entry of `createTestApp`'s `ports`: port to a file name or a double.
   */
  readonly chosen: Readonly<Record<string, unknown>> | undefined;
}

export interface SelectTestImplementationsFunction {
  (args: SelectTestImplementationsArgs): Readonly<Record<string, PortChoice>>;
}

/**
 * Unlike the app's configuration, a port the test leaves out gets no implementation even when it
 * has only one, so a test never reaches a real provider it did not ask for.
 */
export const selectTestImplementations: SelectTestImplementationsFunction = ({
  owner,
  implementations,
  chosen = {},
}) => {
  const label = describeOwner(owner);
  const unknown = Object.keys(chosen).filter((port) => !Object.hasOwn(implementations, port));
  if (unknown.length > 0) {
    throw new ConfigurationError(
      `${label}: createTestApp names ports that do not exist: ${describeNames(unknown)}`,
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
                `${label}, port "${port}": this test app was given none. Pass createTestApp ports: { ${owner.name}: { ${port}: <double> } }, or one of ${describeNames(options)}.`,
              ),
          },
        ];
      }
      if (typeof given !== "string") return [port, { double: given }];
      const module = Object.hasOwn(available, given) ? available[given] : undefined;
      if (module === undefined)
        throw implementationNotFound({ owner: label, port, chosen: given, options });
      return [port, { module }];
    }),
  );
};
