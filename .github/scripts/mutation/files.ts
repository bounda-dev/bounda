import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

export interface MutateFilesFunction {
  (directory: string): readonly string[];
}

// The files a package's Stryker `mutate` patterns select, relative to the package, as Stryker
// names them in its report.
export const mutateFiles: MutateFilesFunction = (directory) => {
  const { mutate } = JSON.parse(readFileSync(join(directory, "stryker.config.json"), "utf8")) as {
    readonly mutate: readonly string[];
  };
  const excluded = mutate
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => pattern.slice(1));
  return globSync(
    mutate.filter((pattern) => !pattern.startsWith("!")),
    { cwd: directory },
  )
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !excluded.some((pattern) => matchesGlob(file, pattern)))
    .sort();
};
