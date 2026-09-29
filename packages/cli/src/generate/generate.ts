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
   * The application directory under `root`.
   */
  readonly appDir?: string;
  /**
   * The `tsconfig.json` TypeScript opens to infer state.
   */
  readonly tsconfigPath?: string;
  /**
   * `false` leaves aggregates without `state.ts` as `core.UnknownState`, without starting
   * TypeScript.
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
 * Runs the generator: writes `.bounda/` and every `+types` file, with the state of aggregates
 * without `state.ts` inferred, and removes `+types` files whose module is gone. A file whose
 * content is unchanged is not rewritten. Throws `ConventionError` when the layout breaks a
 * convention; inference problems come back as warnings.
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
