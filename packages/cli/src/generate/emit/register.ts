import type { GeneratedFile } from "./paths.ts";

export interface EmitRegisterArgs {
  readonly path: string;
}

export interface EmitRegisterFunction {
  (args: EmitRegisterArgs): GeneratedFile;
}

/**
 * `.bounda/register.d.ts`: registers the project's registry type with `@bounda-dev/core/register`,
 * so that
 * `BoundaApp`, `boot()` and the integrations are typed for the project without a type argument.
 */
export const emitRegister: EmitRegisterFunction = ({ path }) => ({
  path,
  content: [
    'import type { registry } from "./registry.ts";',
    "",
    'declare module "@bounda-dev/core/register" {',
    "  interface Register {",
    "    readonly registry: typeof registry;",
    "  }",
    "}",
    "",
  ].join("\n"),
});
