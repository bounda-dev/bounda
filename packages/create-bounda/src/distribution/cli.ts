import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { check, type Scaffolder, sync } from "./sync.ts";

const USAGE = `Usage:
  pnpm templates:sync --into <clone> [--scaffolder published|workspace]
  pnpm templates:check [--scaffolder published|workspace] [--clone <clone>]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    into: { type: "string" },
    clone: { type: "string" },
    scaffolder: { type: "string", default: "published" },
  },
});

const [command] = positionals;
const scaffolder = values.scaffolder as Scaffolder;

if (scaffolder !== "published" && scaffolder !== "workspace") {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

if (command === "sync") {
  if (values.into === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  await sync({ scaffolder, into: resolve(values.into) });
  process.stdout.write(
    `synced bounda-cloudflare-template into ${values.into}; review the diff and open a PR\n`,
  );
} else if (command === "check") {
  const drift = await check({
    scaffolder,
    ...(values.clone === undefined ? {} : { clone: resolve(values.clone) }),
  });
  for (const { path, kind } of drift) process.stdout.write(`${kind.padEnd(8)} ${path}\n`);
  if (drift.length > 0) {
    process.stdout.write(
      `bounda-cloudflare-template differs from the ${scaffolder} scaffolder: run pnpm templates:sync\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`bounda-cloudflare-template matches the ${scaffolder} scaffolder\n`);
} else {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
