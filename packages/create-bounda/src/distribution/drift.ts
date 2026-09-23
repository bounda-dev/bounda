import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface Drift {
  readonly path: string;
  /**
   * `missing`: the copy lacks a file the generated output has. `extra`: the copy has a file the
   * output does not. `changed`: both have it with different contents.
   */
  readonly kind: "missing" | "extra" | "changed";
}

export interface DriftBetweenArgs {
  readonly expected: ReadonlyMap<string, string>;
  readonly actual: ReadonlyMap<string, string>;
  /**
   * Paths regenerated on every sync, compared by presence only: a lockfile or
   * `worker-configuration.d.ts` changes with every third-party release.
   */
  readonly regenerated: readonly string[];
}

export interface DriftBetweenFunction {
  (args: DriftBetweenArgs): readonly Drift[];
}

/**
 * Every difference between what a sync would write and what a copy holds, sorted by path.
 */
export const driftBetween: DriftBetweenFunction = ({ expected, actual, regenerated }) => {
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return paths.flatMap((path): readonly Drift[] => {
    const wanted = expected.get(path);
    const found = actual.get(path);
    if (found === undefined) return [{ path, kind: "missing" }];
    if (wanted === undefined) return [{ path, kind: "extra" }];
    if (regenerated.includes(path) || wanted === found) return [];
    return [{ path, kind: "changed" }];
  });
};

export interface ReadTreeFunction {
  (root: string, skip: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

/**
 * Every file under `root` by its path relative to it, `/`-separated, leaving out the directories
 * named in `skip` wherever they appear.
 */
export const readTree: ReadTreeFunction = async (root, skip) => {
  const files = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(relative(root, path).split("\\").join("/"), await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return files;
};
