// Prints, comma separated, the files of a package's `mutate` patterns that fall to one shard of
// its mutation run: `node .github/scripts/mutation-shard.ts <package> <shard> <shards>`, the shard
// counted from 1. A file's shard is a hash of its path, so it keeps it as other files come and
// go, and the shard's incremental cache stays valid.
import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

const [name = "", shardText = "", shardsText = ""] = process.argv.slice(2);
const shard = Number(shardText);
const shards = Number(shardsText);
if (
  name === "" ||
  !Number.isInteger(shard) ||
  !Number.isInteger(shards) ||
  shard < 1 ||
  shard > shards
) {
  throw new Error("usage: mutation-shard.ts <package> <shard> <shards>, the shard counted from 1");
}
const directory = join("packages", name);
const { mutate } = JSON.parse(readFileSync(join(directory, "stryker.config.json"), "utf8")) as {
  readonly mutate: readonly string[];
};
const excluded = mutate
  .filter((pattern) => pattern.startsWith("!"))
  .map((pattern) => pattern.slice(1));
const files = globSync(
  mutate.filter((pattern) => !pattern.startsWith("!")),
  { cwd: directory },
)
  .filter((file) => !excluded.some((pattern) => matchesGlob(file, pattern)))
  .sort();
const shardOf = (file: string): number =>
  createHash("sha256").update(file).digest().readUInt32BE(0) % shards;
process.stdout.write(`${files.filter((file) => shardOf(file) === shard - 1).join(",")}\n`);
