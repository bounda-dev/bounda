import { join } from "node:path";
import type { ProjectModel } from "../model.ts";
import type { GeneratedFile } from "./paths.ts";
import { emitPlusTypes } from "./plus-types.ts";
import { emitRegister } from "./register.ts";
import { emitRegistry } from "./registry.ts";
import { emitTypes, type StateTypeSource } from "./types.ts";

export const GENERATED_DIRECTORY: string = ".bounda";

export interface EmitProjectArgs {
  readonly model: ProjectModel;
  readonly inferredStates?: Readonly<Record<string, StateTypeSource>>;
}

export interface EmitProjectFunction {
  (args: EmitProjectArgs): readonly GeneratedFile[];
}

/**
 * Every file the generator produces for a project: `.bounda/registry.ts`, `.bounda/register.d.ts`,
 * `.bounda/types.ts` and the `+types` of each module, with absolute paths.
 */
export const emitProject: EmitProjectFunction = ({ model, inferredStates }) => {
  const directory = join(model.root, GENERATED_DIRECTORY);
  const typesPath = join(directory, "types.ts");
  return [
    emitRegistry({ model, path: join(directory, "registry.ts") }),
    emitRegister({ path: join(directory, "register.d.ts") }),
    emitTypes({
      model,
      path: typesPath,
      ...(inferredStates === undefined ? {} : { inferredStates }),
    }),
    ...emitPlusTypes({ model, typesPath }),
  ];
};

export type { GeneratedFile } from "./paths.ts";
export { importPath } from "./paths.ts";
export type { EmitPlusTypesArgs, EmitPlusTypesFunction } from "./plus-types.ts";
export { emitPlusTypes, plusTypesPath } from "./plus-types.ts";
export type { EmitRegisterArgs, EmitRegisterFunction } from "./register.ts";
export { emitRegister } from "./register.ts";
export type { EmitRegistryArgs, EmitRegistryFunction } from "./registry.ts";
export { emitRegistry } from "./registry.ts";
export type { EmitTypesArgs, EmitTypesFunction, StateTypeSource } from "./types.ts";
export { emitTypes } from "./types.ts";
