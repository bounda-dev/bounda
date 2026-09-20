import { dirname, posix, relative } from "node:path";

export interface ImportPathArgs {
  /**
   * Absolute path of the file that contains the import.
   */
  readonly from: string;
  /**
   * Absolute path of the imported module.
   */
  readonly to: string;
}

export interface ImportPathFunction {
  (args: ImportPathArgs): string;
}

/**
 * The specifier that imports `to` from `from`: relative, with forward slashes, starting with `./`
 * or `../`, keeping the `.ts` extension.
 */
export const importPath: ImportPathFunction = ({ from, to }) => {
  const specifier = relative(dirname(from), to).split("\\").join(posix.sep);
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
};

export interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}
