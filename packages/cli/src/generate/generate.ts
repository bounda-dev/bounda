import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProject } from "./discover.ts";
import { emitProject, GENERATED_DIRECTORY } from "./emit/index.ts";
import type { GeneratedFile } from "./emit/paths.ts";
import type { ProjectModel } from "./model.ts";
import { inferStates, type StateWarning } from "./state/infer.ts";
import { removeOrphans, writeGeneratedFile, writeGeneratedFiles } from "./write.ts";

export interface GenerateArgs {
  readonly root: string;
  /**
   * The application directory under `root`. Defaults to `app`.
   */
  readonly appDir?: string;
  /**
   * The `tsconfig.json` the checker opens to infer state. Defaults to `<root>/tsconfig.json`.
   */
  readonly tsconfigPath?: string;
  /**
   * Whether to infer `State` for aggregates without `state.ts`. Defaults to `true`; `false`
   * leaves them as `core.UnknownState` without starting TypeScript.
   */
  readonly inferState?: boolean;
}

export interface GenerateReport {
  readonly model: ProjectModel;
  readonly files: readonly GeneratedFile[];
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  readonly warnings: readonly StateWarning[];
}

export interface GenerateFunction {
  (args: GenerateArgs): Promise<GenerateReport>;
}

/**
 * The whole generator: discover the project, emit and write `.bounda/registry.ts`,
 * `.bounda/types.ts` and every `+types` file, infer the state of aggregates without `state.ts`
 * and write the types again, then remove `+types` files whose module is gone. Throws
 * `ConventionError` when the layout breaks a convention; inference problems are warnings.
 */
export const generate: GenerateFunction = async ({
  root,
  appDir = "app",
  tsconfigPath = join(root, "tsconfig.json"),
  inferState = true,
}) => {
  const model = await discoverProject({ root, appDir });
  const typesPath = join(root, GENERATED_DIRECTORY, "types.ts");
  const typesBefore = await readFile(typesPath, "utf8").catch(() => null);
  const firstPass = emitProject({ model });
  const first = await writeGeneratedFiles(firstPass);
  const needsInference =
    inferState && model.aggregates.some((aggregate) => aggregate.state === null);
  const inferred = needsInference
    ? await inferStates({
        model,
        tsconfigPath,
        typesPath,
        renderTypes: (states) =>
          emitProject({ model, inferredStates: states }).find((file) => file.path === typesPath)
            ?.content ?? "",
        write: async (path, content) => {
          await writeGeneratedFile(path, content);
        },
      })
    : { states: {}, warnings: [] };
  const files = emitProject({ model, inferredStates: inferred.states });
  const typesAfter = files.find((file) => file.path === typesPath)?.content ?? "";
  const removed = await removeOrphans({
    appDirectory: join(root, appDir),
    keep: new Set(files.map((file) => file.path)),
  });
  const written = [
    ...first.written.filter((path) => path !== typesPath),
    ...(typesAfter === typesBefore ? [] : [typesPath]),
  ].sort();
  return {
    model,
    files,
    written,
    unchanged: files
      .map((file) => file.path)
      .filter((path) => !written.includes(path))
      .sort(),
    removed,
    warnings: inferred.warnings,
  };
};
