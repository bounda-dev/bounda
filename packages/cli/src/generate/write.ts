import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GeneratedFile } from "./emit/paths.ts";

export interface WriteReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
}

export interface WriteGeneratedFileFunction {
  (path: string, content: string): Promise<"written" | "unchanged">;
}

/**
 * Writes a file only when its content differs, so watchers downstream see no spurious change.
 */
export const writeGeneratedFile: WriteGeneratedFileFunction = async (path, content) => {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) return "unchanged";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return "written";
};

export interface WriteGeneratedFilesFunction {
  (files: readonly GeneratedFile[]): Promise<WriteReport>;
}

export const writeGeneratedFiles: WriteGeneratedFilesFunction = async (files) => {
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const file of files) {
    ((await writeGeneratedFile(file.path, file.content)) === "written" ? written : unchanged).push(
      file.path,
    );
  }
  return { written, unchanged };
};

export interface RemoveOrphansArgs {
  /**
   * The application directory to sweep for `+types` files.
   */
  readonly appDirectory: string;
  /**
   * Every path the generator produced this run; anything else under a `+types` directory goes.
   */
  readonly keep: ReadonlySet<string>;
}

export interface RemoveOrphansFunction {
  (args: RemoveOrphansArgs): Promise<readonly string[]>;
}

/**
 * Deletes `+types` files whose module no longer exists, and `+types` directories left empty.
 */
export const removeOrphans: RemoveOrphansFunction = async ({ appDirectory, keep }) => {
  const removed: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (entry.name !== "+types") {
        await walk(path);
        continue;
      }
      for (const generated of await readdir(path)) {
        const file = join(path, generated);
        if (!keep.has(file)) {
          await rm(file);
          removed.push(file);
        }
      }
      if ((await readdir(path)).length === 0) await rm(path, { recursive: true });
    }
  };
  await walk(appDirectory);
  return removed.sort();
};
