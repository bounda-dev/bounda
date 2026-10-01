import type { GeneratedFile } from "./paths.ts";
import { COLLABORATORS_CONFIG_TYPE_NAME } from "./types.ts";

export interface EmitRegisterArgs {
  readonly path: string;
}

export interface EmitRegisterFunction {
  (args: EmitRegisterArgs): GeneratedFile;
}

/**
 * Registers the registry type and the type of the `collaborators` configuration with
 * `@bounda-dev/core/register`, so `BoundaApp`, `boot()` and the integrations are typed for the
 * project without a type argument and `defineConfig` checks the implementation names.
 */
export const emitRegister: EmitRegisterFunction = ({ path }) => ({
  path,
  content: [
    'import type { registry } from "./registry.ts";',
    `import type { ${COLLABORATORS_CONFIG_TYPE_NAME} } from "./types.ts";`,
    "",
    'declare module "@bounda-dev/core/register" {',
    "  interface Register {",
    "    readonly registry: typeof registry;",
    `    readonly collaborators: ${COLLABORATORS_CONFIG_TYPE_NAME};`,
    "  }",
    "}",
    "",
  ].join("\n"),
});
