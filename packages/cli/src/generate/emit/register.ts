import type { GeneratedFile } from "./paths.ts";
import { PORTS_CONFIG_TYPE_NAME, TEST_PORTS_TYPE_NAME } from "./types.ts";

export interface EmitRegisterArgs {
  readonly path: string;
}

export interface EmitRegisterFunction {
  (args: EmitRegisterArgs): GeneratedFile;
}

/**
 * Registers the registry type and the types of the `ports` configuration and of
 * `createTestApp`'s `ports` with `@bounda-dev/core/register`, so `BoundaApp`, `boot()` and
 * the integrations are typed for the project without a type argument and `defineConfig` and
 * `createTestApp` check the implementation names.
 */
export const emitRegister: EmitRegisterFunction = ({ path }) => ({
  path,
  content: [
    'import type { registry } from "./registry.ts";',
    `import type { ${PORTS_CONFIG_TYPE_NAME}, ${TEST_PORTS_TYPE_NAME} } from "./types.ts";`,
    "",
    'declare module "@bounda-dev/core/register" {',
    "  interface Register {",
    "    readonly registry: typeof registry;",
    `    readonly ports: ${PORTS_CONFIG_TYPE_NAME};`,
    `    readonly testPorts: ${TEST_PORTS_TYPE_NAME};`,
    "  }",
    "}",
    "",
  ].join("\n"),
});
