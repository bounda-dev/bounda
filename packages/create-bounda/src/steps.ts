import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PackageManager } from "./options.ts";

const run = promisify(execFile);

/**
 * Runs an external command in a directory. Injected so tests can record instead of spawning.
 */
export interface Exec {
  (command: string, args: readonly string[], cwd: string): Promise<void>;
}

export const realExec: Exec = async (command, args, cwd) => {
  await run(command, [...args], { cwd, env: process.env });
};

export interface InstallCommandFunction {
  (packageManager: PackageManager): readonly [string, readonly string[]];
}

/**
 * The install command of each package manager. Installing also runs the project's `prepare`
 * script, which generates the types, in every template but Cloudflare's.
 */
export const installCommand: InstallCommandFunction = (packageManager) =>
  packageManager === "yarn" ? ["yarn", []] : [packageManager, ["install"]];

export interface GenerateCommandFunction {
  (packageManager: PackageManager): readonly [string, readonly string[]];
}

/**
 * Runs the project's `generate` script. A Cloudflare project has no `prepare`, because npm runs it
 * even for `npm install --package-lock-only`, when there is nothing to run it with; this is what
 * gives its editor the registry and the binding types right after the install.
 */
export const generateCommand: GenerateCommandFunction = (packageManager) => [
  packageManager,
  ["run", "generate"],
];

export interface RunCommandFunction {
  (packageManager: PackageManager, script: string): string;
}

/**
 * How to invoke a package script with each package manager, for the closing message.
 */
export const runCommand: RunCommandFunction = (packageManager, script) => {
  if (script === "install") return packageManager === "yarn" ? "yarn" : `${packageManager} install`;
  if (packageManager === "npm") {
    return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  }
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} ${script}`;
};
