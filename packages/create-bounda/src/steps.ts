import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { PackageManager } from "./options.ts";

const run = promisify(exec);

export interface Exec {
  (command: string, args: readonly string[], cwd: string): Promise<void>;
}

const PLAIN_WORD = /^[\w.-]+$/;

// Through the shell on every platform: on Windows npm, pnpm and yarn are `.cmd` shims, which only a
// shell runs, and one way everywhere is the way the tests cover. The words are joined unquoted, so
// anything but a plain word is refused rather than split or interpreted.
export const realExec: Exec = async (command, args, cwd) => {
  const words = [command, ...args];
  const unsafe = words.find((word) => !PLAIN_WORD.test(word));
  if (unsafe !== undefined) {
    throw new Error(`refusing to pass ${JSON.stringify(unsafe)} through the shell`);
  }
  await run(words.join(" "), { cwd, env: process.env });
};

export interface InstallCommandFunction {
  (packageManager: PackageManager): readonly [string, readonly string[]];
}

// Installing also runs the project's `prepare` script, which generates the types, in every
// template but Cloudflare's.
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

export const runCommand: RunCommandFunction = (packageManager, script) => {
  if (script === "install") return packageManager === "yarn" ? "yarn" : `${packageManager} install`;
  if (packageManager === "npm") {
    return script === "test" || script === "start" ? `npm ${script}` : `npm run ${script}`;
  }
  if (packageManager === "bun") return `bun run ${script}`;
  return `${packageManager} ${script}`;
};
