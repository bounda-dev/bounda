import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as clack from "@clack/prompts";
import { Command, CommanderError } from "commander";
import { type CreateOptions, type Prompts, resolveOptions } from "./options.ts";
import { scaffoldProject } from "./scaffold.ts";
import { type Exec, installCommand, realExec, runCommand } from "./steps.ts";
import { currentVersions } from "./versions.ts";

export interface Output {
  write(text: string): void;
}

export interface RunCreateArgs {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdout: Output;
  readonly stderr: Output;
  /**
   * Prompts to use when a flag is missing; `null` means non-interactive (defaults are used).
   * Defaults to clack when stdin is a terminal.
   */
  readonly prompts?: Prompts | null;
  /**
   * Runs `git init` and the install; defaults to spawning the real commands.
   */
  readonly exec?: Exec;
  readonly userAgent?: string | undefined;
  readonly templateRoot?: string;
}

export interface RunCreateFunction {
  (args: RunCreateArgs): Promise<number>;
}

export const EXIT_OK: number = 0;
export const EXIT_FAILURE: number = 1;

const defaultTemplateRoot = (): string => fileURLToPath(new URL("../template/", import.meta.url));

const clackPrompts: Prompts = {
  text: async (message, fallback) => {
    const answer = await clack.text({ message, placeholder: fallback, defaultValue: fallback });
    return clack.isCancel(answer) ? null : answer;
  },
  select: async <Value extends string>(
    message: string,
    options: readonly { readonly value: Value; readonly label: string; readonly hint?: string }[],
  ) => {
    const answer = await clack.select({
      message,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.hint === undefined ? {} : { hint: option.hint }),
      })) as clack.Option<Value>[],
    });
    return clack.isCancel(answer) ? null : answer;
  },
};

interface Flags {
  readonly database?: string;
  readonly framework?: string;
  readonly pm?: string;
  readonly install: boolean;
  readonly git: boolean;
  readonly yes: boolean;
}

const nextSteps = (options: CreateOptions, cwd: string): string => {
  const where = relative(cwd, options.directory) || ".";
  const lines = [`cd ${where}`];
  if (!options.install) lines.push(runCommand(options.packageManager, "install"));
  lines.push(
    runCommand(options.packageManager, "test"),
    runCommand(options.packageManager, options.framework === "node" ? "start" : "dev"),
  );
  return lines.map((line) => `  ${line}`).join("\n");
};

const create = async (
  directory: string | undefined,
  flags: Flags,
  {
    cwd,
    stdout,
    stderr,
    prompts,
    exec,
    userAgent,
    templateRoot,
  }: Required<
    Pick<
      RunCreateArgs,
      "cwd" | "stdout" | "stderr" | "prompts" | "exec" | "userAgent" | "templateRoot"
    >
  >,
): Promise<number> => {
  const resolved = await resolveOptions({
    raw: {
      ...(directory === undefined ? {} : { directory }),
      ...(flags.database === undefined ? {} : { database: flags.database }),
      ...(flags.framework === undefined ? {} : { framework: flags.framework }),
      ...(flags.pm === undefined ? {} : { packageManager: flags.pm }),
      install: flags.install,
      git: flags.git,
      yes: flags.yes,
    },
    cwd,
    userAgent,
    prompts,
  });
  if (resolved === "cancelled") {
    stderr.write("cancelled\n");
    return EXIT_FAILURE;
  }
  const report = await scaffoldProject({
    templateRoot,
    options: resolved,
    versions: currentVersions(),
  });
  stdout.write(
    `created ${resolved.name} in ${relative(cwd, resolved.directory) || "."} (${report.files.length} files, ${resolved.database}, ${resolved.framework})\n`,
  );
  if (resolved.git) {
    try {
      await exec("git", ["init", "--quiet"], resolved.directory);
      stdout.write("initialised a git repository\n");
    } catch (error) {
      stderr.write(
        `warning: git init failed (${error instanceof Error ? error.message : String(error)})\n`,
      );
    }
  }
  if (resolved.install) {
    const [command, args] = installCommand(resolved.packageManager);
    stdout.write(`installing dependencies with ${resolved.packageManager}\n`);
    try {
      await exec(command, args, resolved.directory);
    } catch (error) {
      stderr.write(
        `warning: install failed (${error instanceof Error ? error.message : String(error)}); run ${runCommand(resolved.packageManager, "install")} yourself\n`,
      );
    }
  }
  stdout.write(`\nnext:\n${nextSteps(resolved, cwd)}\n`);
  return EXIT_OK;
};

/**
 * `create-bounda [directory]` as a function: parses the arguments, asks what is missing, copies
 * the template, optionally runs `git init` and the install, and returns the exit code.
 */
export const runCreate: RunCreateFunction = async ({
  argv,
  cwd,
  stdout,
  stderr,
  prompts = process.stdin.isTTY ? clackPrompts : null,
  exec = realExec,
  userAgent = process.env.npm_config_user_agent,
  templateRoot = defaultTemplateRoot(),
}) => {
  let exitCode = EXIT_OK;
  const program = new Command("create-bounda")
    .description("Create a Bounda project")
    .argument("[directory]", "where to create it (default: bounda-app, or asked)")
    .option("--database <name>", "sqlite or postgresql (default: sqlite, or asked)")
    .option("--framework <name>", "node or react-router (default: node, or asked)")
    .option(
      "--pm <name>",
      "package manager: pnpm, npm, yarn or bun (default: the one running this)",
    )
    .option("--no-install", "do not install dependencies")
    .option("--no-git", "do not run git init")
    .option("-y, --yes", "take the defaults instead of asking", false)
    .configureOutput({
      writeOut: (text) => stdout.write(text),
      writeErr: (text) => stderr.write(text),
    })
    .exitOverride()
    .action(async (directory: string | undefined, flags: Flags) => {
      exitCode = await create(directory, flags, {
        cwd,
        stdout,
        stderr,
        prompts,
        exec,
        userAgent,
        templateRoot,
      });
    });
  try {
    await program.parseAsync([...argv], { from: "user" });
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT_OK : EXIT_FAILURE;
    stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_FAILURE;
  }
};
