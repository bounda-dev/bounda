#!/usr/bin/env node
import { runCreate } from "./run.ts";

process.exitCode = await runCreate({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
