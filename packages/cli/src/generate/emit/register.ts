import type { GeneratedFile } from "./paths.ts";
import {
  PERSONAL_CATEGORY_TYPE_NAME,
  PORTS_CONFIG_TYPE_NAME,
  TEST_PORTS_TYPE_NAME,
} from "./types.ts";

export interface EmitRegisterArgs {
  readonly path: string;
}

export interface EmitRegisterFunction {
  (args: EmitRegisterArgs): GeneratedFile;
}

/**
 * Registers the registry type, the types of the `ports` configuration and of `createTestApp`'s
 * `ports`, and the names of the categories of personal data with `@bounda-dev/core/register`, so
 * `BoundaApp`, `boot()` and the integrations are typed for the project without a type argument,
 * `defineConfig` and `createTestApp` check the implementation names, and `personal({ category })`
 * and `forget` check the categories.
 */
export const emitRegister: EmitRegisterFunction = ({ path }) => ({
  path,
  content: [
    'import type { registry } from "./registry.ts";',
    `import type { ${PERSONAL_CATEGORY_TYPE_NAME}, ${PORTS_CONFIG_TYPE_NAME}, ${TEST_PORTS_TYPE_NAME} } from "./types.ts";`,
    "",
    'declare module "@bounda-dev/core/register" {',
    "  interface Register {",
    "    readonly registry: typeof registry;",
    `    readonly ports: ${PORTS_CONFIG_TYPE_NAME};`,
    `    readonly testPorts: ${TEST_PORTS_TYPE_NAME};`,
    `    readonly personalCategories: ${PERSONAL_CATEGORY_TYPE_NAME};`,
    "  }",
    "}",
    "",
  ].join("\n"),
});
