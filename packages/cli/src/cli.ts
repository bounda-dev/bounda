#!/usr/bin/env node
import { runCli } from "./run.ts";

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
