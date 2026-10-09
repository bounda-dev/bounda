import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProject } from "./discover.ts";
import { emitProject, GENERATED_DIRECTORY } from "./emit/index.ts";
import type { GeneratedFile } from "./emit/paths.ts";
import type { StateTypeSource } from "./emit/types.ts";
import type { GenerateWarning, ProjectModel } from "./model.ts";
import { inferStates } from "./state/infer.ts";
import { removeOrphans, writeGeneratedFile, writeGeneratedFiles } from "./write.ts";

export interface GenerateArgs {
  readonly root: string;
  /**
   * The application directory under `root`. Defaults to `app`.
   */
  readonly appDir?: string;
  /**
   * The `tsconfig.json` TypeScript opens to infer state. Defaults to `<root>/tsconfig.json`.
   */
  readonly tsconfigPath?: string;
  /**
   * Defaults to `true`; `false` leaves aggregates without `state.ts` as `core.UnknownState`,
   * without starting TypeScript.
   */
  readonly inferState?: boolean;
}

/**
 * What a run of the generator did: absolute paths written, left unchanged and removed, and the
 * warnings about the layout and state inference.
 */
export interface GenerateReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
  readonly warnings: readonly GenerateWarning[];
}

export interface GenerateFunction {
  (args: GenerateArgs): Promise<GenerateReport>;
}

export interface GeneratedProject extends GenerateReport {
  readonly model: ProjectModel;
  readonly files: readonly GeneratedFile[];
}

export interface GenerateProjectFunction {
  (args: GenerateArgs): Promise<GeneratedProject>;
}

export const generateProject: GenerateProjectFunction = async ({
  root,
  appDir = "app",
  tsconfigPath = join(root, "tsconfig.json"),
  inferState = true,
}) => {
  const { warnings, ...model } = await discoverProject({ root, appDir });
  const typesPath = join(root, GENERATED_DIRECTORY, "types.ts");
  const typesBefore = await readFile(typesPath, "utf8").catch(() => null);
  const firstPass = emitProject({ model });
  const needsInference =
    inferState && model.aggregates.some((aggregate) => aggregate.state === null);
  // Inference reads the first-pass types from memory, so an existing types.ts is written once,
  // with its final content, or not at all: watchers never see the uninferred one. The project
  // only has to find the file, which a first run writes.
  const first = await writeGeneratedFiles(
    needsInference && typesBefore !== null
      ? firstPass.filter((file) => file.path !== typesPath)
      : firstPass,
  );
  const typesRender = (states: Readonly<Record<string, StateTypeSource>>): string =>
    emitProject({ model, inferredStates: states }).find((file) => file.path === typesPath)
      ?.content ?? "";
  const inferred = needsInference
    ? await inferStates({
        model,
        tsconfigPath,
        typesPath,
        typesContent: firstPass.find((file) => file.path === typesPath)?.content ?? "",
        renderTypes: typesRender,
      })
    : { states: {}, warnings: [] };
  const files = emitProject({ model, inferredStates: inferred.states });
  const typesAfter = files.find((file) => file.path === typesPath)?.content ?? "";
  await writeGeneratedFile(typesPath, typesAfter);
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
    warnings: [
      ...warnings,
      ...inferred.warnings.map(({ aggregate, message }) => ({ module: aggregate, message })),
    ],
  };
};

/**
 * Runs the generator: writes `.bounda/` and every `+types` file, with the state of aggregates
 * without `state.ts` inferred, and removes `+types` files whose module is gone. A file whose
 * content is unchanged is not rewritten. Throws `ConventionError` when the layout breaks a
 * convention; a layout that is probably wrong and inference problems come back as warnings.
 */
export const generate: GenerateFunction = generateProject;
