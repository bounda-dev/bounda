import { basename, resolve } from "node:path";

export type Database = "sqlite" | "postgresql";
export type Framework = "node" | "react-router";
export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

export const DATABASES: readonly Database[] = ["sqlite", "postgresql"];
export const FRAMEWORKS: readonly Framework[] = ["node", "react-router"];
export const PACKAGE_MANAGERS: readonly PackageManager[] = ["pnpm", "npm", "yarn", "bun"];
export const DEFAULT_DIRECTORY: string = "bounda-app";

/**
 * What the command line gave us; anything missing is asked for or defaulted.
 */
export interface RawOptions {
  readonly directory?: string;
  readonly database?: string;
  readonly framework?: string;
  readonly packageManager?: string;
  readonly install: boolean;
  readonly git: boolean;
  readonly yes: boolean;
}

/**
 * Everything the scaffold needs, resolved.
 */
export interface CreateOptions {
  readonly directory: string;
  readonly name: string;
  readonly database: Database;
  readonly framework: Framework;
  readonly packageManager: PackageManager;
  readonly install: boolean;
  readonly git: boolean;
}

export interface DetectPackageManagerFunction {
  (userAgent: string | undefined): PackageManager;
}

/**
 * The package manager that ran `create bounda`, from `npm_config_user_agent`; `npm` otherwise.
 */
export const detectPackageManager: DetectPackageManagerFunction = (userAgent) => {
  const name = userAgent?.split("/")[0];
  return PACKAGE_MANAGERS.find((candidate) => candidate === name) ?? "npm";
};

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export interface ProjectNameOfFunction {
  (directory: string): string;
}

/**
 * The package name for a directory: its base name, lower-cased, with anything npm rejects turned
 * into a dash. `.` gives the current directory's name.
 */
export const projectNameOf: ProjectNameOfFunction = (directory) => {
  const candidate = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-._~]+/g, "-")
    .replace(/^[-._]+/, "");
  return PACKAGE_NAME.test(candidate) && candidate.length > 0 ? candidate : "bounda-app";
};

export interface Prompts {
  text(message: string, fallback: string): Promise<string | null>;
  select<Value extends string>(
    message: string,
    options: readonly { readonly value: Value; readonly label: string; readonly hint?: string }[],
  ): Promise<Value | null>;
}

export interface ResolveOptionsArgs {
  readonly raw: RawOptions;
  readonly cwd: string;
  readonly userAgent: string | undefined;
  /**
   * Asks for what the flags did not say. `null` from a prompt means the user cancelled.
   */
  readonly prompts: Prompts | null;
}

export interface ResolveOptionsFunction {
  (args: ResolveOptionsArgs): Promise<CreateOptions | "cancelled">;
}

const isDatabase = (value: string | undefined): value is Database =>
  DATABASES.some((candidate) => candidate === value);

const isFramework = (value: string | undefined): value is Framework =>
  FRAMEWORKS.some((candidate) => candidate === value);

const isPackageManager = (value: string | undefined): value is PackageManager =>
  PACKAGE_MANAGERS.some((candidate) => candidate === value);

/**
 * Fills the options: flags first, then prompts (unless `--yes` or no terminal), then defaults.
 * Invalid flag values throw with the accepted values.
 */
export const resolveOptions: ResolveOptionsFunction = async ({ raw, cwd, userAgent, prompts }) => {
  if (raw.database !== undefined && !isDatabase(raw.database)) {
    throw new Error(`--database must be one of ${DATABASES.join(", ")}; got "${raw.database}"`);
  }
  if (raw.framework !== undefined && !isFramework(raw.framework)) {
    throw new Error(`--framework must be one of ${FRAMEWORKS.join(", ")}; got "${raw.framework}"`);
  }
  if (raw.packageManager !== undefined && !isPackageManager(raw.packageManager)) {
    throw new Error(
      `--pm must be one of ${PACKAGE_MANAGERS.join(", ")}; got "${raw.packageManager}"`,
    );
  }
  const ask = raw.yes ? null : prompts;

  let directory = raw.directory;
  if (directory === undefined) {
    if (ask === null) directory = DEFAULT_DIRECTORY;
    else {
      const answer = await ask.text("Where should the project go?", DEFAULT_DIRECTORY);
      if (answer === null) return "cancelled";
      directory = answer.trim() === "" ? DEFAULT_DIRECTORY : answer.trim();
    }
  }

  let database: Database | undefined = raw.database;
  if (database === undefined) {
    if (ask === null) database = "sqlite";
    else {
      const answer = await ask.select("Which database?", [
        { value: "sqlite" as const, label: "SQLite", hint: "a file, no server; also Turso" },
        { value: "postgresql" as const, label: "PostgreSQL", hint: "for several instances" },
      ]);
      if (answer === null) return "cancelled";
      database = answer;
    }
  }

  let framework: Framework | undefined = raw.framework;
  if (framework === undefined) {
    if (ask === null) framework = "node";
    else {
      const answer = await ask.select("How will the app run?", [
        { value: "node" as const, label: "Node", hint: "a script, a worker or your own server" },
        { value: "react-router" as const, label: "React Router", hint: "framework mode, Vite" },
      ]);
      if (answer === null) return "cancelled";
      framework = answer;
    }
  }

  return {
    directory: resolve(cwd, directory),
    name: projectNameOf(resolve(cwd, directory)),
    database,
    framework,
    packageManager: raw.packageManager ?? detectPackageManager(userAgent),
    install: raw.install,
    git: raw.git,
  };
};
