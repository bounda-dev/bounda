import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverProject } from "./discover.ts";
import { emitProject, GENERATED_DIRECTORY } from "./emit/index.ts";
import type { GeneratedFile } from "./emit/paths.ts";
import type { StateTypeSource } from "./emit/types.ts";
import { fingerprintStates, readStateSources } from "./fingerprint.ts";
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
  const sources = await readStateSources(model);
  const typesPath = join(root, GENERATED_DIRECTORY, "types.ts");
  const registryPath = join(root, GENERATED_DIRECTORY, "registry.ts");
  const before = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);
  const typesBefore = await before(typesPath);
  const registryBefore = await before(registryPath);
  const firstPass = emitProject({ model, fingerprints: fingerprintStates({ sources }) });
  const needsInference =
    inferState && model.aggregates.some((aggregate) => aggregate.state === null);
  // Inference reads the first-pass types from memory, and the registry's fingerprints take the
  // inferred types in, so each of the two, when it exists, is written once, with its final
  // content, or not at all: watchers never see the uninferred one. The project only has to find
  // the files, which a first run writes.
  const deferred = new Set(
    needsInference
      ? [
          ...(typesBefore === null ? [] : [typesPath]),
          ...(registryBefore === null ? [] : [registryPath]),
        ]
      : [],
  );
  const first = await writeGeneratedFiles(firstPass.filter((file) => !deferred.has(file.path)));
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
  const files = emitProject({
    model,
    inferredStates: inferred.states,
    fingerprints: fingerprintStates({ sources, inferredStates: inferred.states }),
  });
  const contentOf = (path: string): string =>
    files.find((file) => file.path === path)?.content ?? "";
  const typesAfter = contentOf(typesPath);
  const registryAfter = contentOf(registryPath);
  await writeGeneratedFile(typesPath, typesAfter);
  await writeGeneratedFile(registryPath, registryAfter);
  const removed = await removeOrphans({
    appDirectory: join(root, appDir),
    keep: new Set(files.map((file) => file.path)),
  });
  const written = [
    ...first.written.filter((path) => path !== typesPath && path !== registryPath),
    ...(typesAfter === typesBefore ? [] : [typesPath]),
    ...(registryAfter === registryBefore ? [] : [registryPath]),
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
