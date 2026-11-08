#!/usr/bin/env node
import { Console } from "node:console";

// Standard output carries a command's result alone: whatever the app writes to the console goes to
// standard error, with the rest of its logging. Swapped before anything else is loaded, so no
// module keeps a reference to the console writing to standard output.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

const { runCli } = await import("./run.ts");

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
