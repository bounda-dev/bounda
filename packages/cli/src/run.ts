import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { generate } from "./generate/generate.ts";
import { ConventionError } from "./generate/problems.ts";
import { watchProject } from "./generate/watch.ts";
import { formatConventionError, formatReport, formatWarnings } from "./reporter.ts";

export interface Output {
  write(text: string): void;
}

export interface RunCliArgs {
  /**
   * The arguments after the program name, e.g. `["generate", "--watch"]`.
   */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  /**
   * Aborting it ends `--watch`.
   */
  readonly signal?: AbortSignal;
}

export interface RunCliFunction {
  (args: RunCliArgs): Promise<number>;
}

export const EXIT_OK: number = 0;
export const EXIT_CONVENTION: number = 1;
export const EXIT_FAILURE: number = 2;

interface GenerateOptions {
  readonly root?: string;
  readonly appDir: string;
  readonly tsconfig?: string;
  readonly infer: boolean;
  readonly watch: boolean;
}

const version = (): string => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version: string };
  return packageJson.version;
};

const line = (output: Output, text: string): void => {
  if (text.length > 0) output.write(`${text}\n`);
};

const runGenerate = async (
  options: GenerateOptions,
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> => {
  const root = resolve(cwd, options.root ?? ".");
  try {
    const report = await generate({
      root,
      appDir: options.appDir,
      inferState: options.infer,
      ...(options.tsconfig === undefined ? {} : { tsconfigPath: resolve(root, options.tsconfig) }),
    });
    line(stderr, formatWarnings(report));
    line(stdout, formatReport({ report, root }));
    return EXIT_OK;
  } catch (error) {
    if (error instanceof ConventionError) {
      line(stderr, formatConventionError({ error, root }));
      return EXIT_CONVENTION;
    }
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};

/**
 * The `bounda` command line, as a function: parses `argv`, runs the command and returns the exit
 * code instead of exiting, so it can be tested and embedded.
 */
export const runCli: RunCliFunction = async ({ argv, cwd, stdout, stderr, signal }) => {
  let exitCode = EXIT_OK;
  const program = new Command("bounda")
    .description("Bounda: event sourcing and CQRS for TypeScript")
    .version(version(), "-v, --version")
    .configureOutput({
      writeOut: (text) => stdout.write(text),
      writeErr: (text) => stderr.write(text),
    })
    .exitOverride();

  program
    .command("generate")
    .description("write .bounda/registry.ts, .bounda/types.ts and the +types of every module")
    .option("--root <dir>", "project root (default: current directory)")
    .option("--app-dir <dir>", "application directory under the root", "app")
    .option("--tsconfig <file>", "tsconfig used to infer state (default: <root>/tsconfig.json)")
    .option("--no-infer", "do not infer state for aggregates without state.ts")
    .option("--watch", "regenerate when a module changes", false)
    .action(async (options: GenerateOptions) => {
      exitCode = await runGenerate(options, cwd, stdout, stderr);
      if (!options.watch || exitCode === EXIT_FAILURE) return;
      const root = resolve(cwd, options.root ?? ".");
      line(stdout, `watching ${options.appDir}/ for changes`);
      await watchProject({
        root,
        appDir: options.appDir,
        signal: signal ?? new AbortController().signal,
        onChange: async () => {
          exitCode = await runGenerate(options, cwd, stdout, stderr);
        },
        onError: (error) =>
          line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`),
      });
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_OK : EXIT_CONVENTION;
    }
    line(stderr, `error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILURE;
  }
};
