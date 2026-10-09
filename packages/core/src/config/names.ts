import { ConfigurationError } from "../contracts/errors.ts";
import type { Registry } from "../modules/registry.ts";
import type { ResolvedConfig } from "./types.ts";

export interface CheckConfigNamesArgs {
  readonly registry: Registry;
  readonly config: ResolvedConfig;
}

export interface CheckConfigNamesFunction {
  (args: CheckConfigNamesArgs): void;
}

const known = (names: readonly string[]): string => names.join(", ") || "none";

/**
 * The sections keyed by read model or aggregate name only matter for names the registry has: a
 * misspelt key would otherwise be ignored without a word, the read model living on `storage` and
 * the overrides never applying.
 */
export const checkConfigNames: CheckConfigNamesFunction = ({ registry, config }) => {
  const readModels = Object.keys(registry.readModels);
  const aggregates = Object.keys(registry.aggregates);
  const problems = [
    ...Object.keys(config.readModels)
      .filter((name) => !readModels.includes(name))
      .map(
        (name) =>
          `readModels.${name}: there is no read model "${name}"; the registry has: ${known(readModels)}`,
      ),
    ...Object.keys(config.runtime.overrides)
      .filter((name) => !aggregates.includes(name))
      .map(
        (name) =>
          `runtime.overrides.${name}: there is no aggregate "${name}"; the registry has: ${known(aggregates)}`,
      ),
  ];
  if (problems.length > 0) {
    throw new ConfigurationError(
      ["Invalid configuration:", ...problems.map((problem) => `  ${problem}`)].join("\n"),
    );
  }
};
