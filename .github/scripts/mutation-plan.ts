// Splits a package's `mutate` files among its mutation shards and prints, as JSON, the files of
// each: `node .github/scripts/mutation-plan.ts <package> <shards> <incremental.json>`. The
// incremental file, the package's last report, need not exist; without it the files spread by
// size. Every shard reads the same plan, made once, so no file is mutated twice or never. Each
// shard's line on stderr predicts the time its job will take.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mutateFiles } from "./mutation/files.ts";
import { planShards } from "./mutation/plan.ts";
import type { Report } from "./mutation/report.ts";

const [name = "", shardsText = "", incremental = ""] = process.argv.slice(2);
const shards = Number(shardsText);
if (name === "" || incremental === "" || !Number.isInteger(shards) || shards < 1) {
  throw new Error("usage: mutation-plan.ts <package> <shards> <incremental.json>");
}
const directory = join("packages", name);
const read = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;
const previous = read(incremental);
const plan = planShards({
  files: mutateFiles(directory).map((path) => ({
    path,
    source: readFileSync(join(directory, path), "utf8"),
  })),
  report: previous === undefined ? undefined : (JSON.parse(previous) as Report),
  testSource: (path) => read(join(directory, path)),
  shards,
});
for (const [index, { files, mutants, minutes }] of plan.entries()) {
  process.stderr.write(
    `Shard ${index + 1}/${shards}: ${files.length} files, ${Math.round(mutants)} mutants to run, about ${Math.ceil(minutes)} minutes\n`,
  );
}
process.stdout.write(`${JSON.stringify(plan.map(({ files }) => files))}\n`);
