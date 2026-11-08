#!/usr/bin/env node
import { Console } from "node:console";
import { runCli } from "./run.ts";

// Standard output carries a command's result alone: whatever the app writes to the console goes to
// standard error, with the rest of its logging.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
