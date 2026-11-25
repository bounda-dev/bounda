// Merges the mutation reports of a package's shards into one, as a run of the whole package
// writes it, and prints its score: `node .github/scripts/mutation-report.ts <package>
// <merged.json> <previous.json> <shard>...`. Each shard directory holds the shard's
// `mutation.json` and the `files.json` it mutated; the previous report, which need not exist,
// gives the files of a shard that left none. The merged report is the package's next
// incremental file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateFiles } from "./mutation/files.ts";
import { mergeReports } from "./mutation/merge.ts";
import { type Report, scoreOf } from "./mutation/report.ts";

const [name = "", output = "", previousPath = "", ...shardDirectories] = process.argv.slice(2);
if (name === "" || output === "" || previousPath === "") {
  throw new Error("usage: mutation-report.ts <package> <merged.json> <previous.json> <shard>...");
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const shards = shardDirectories
  .filter((directory) => existsSync(join(directory, "mutation.json")))
  .map((directory) => ({
    report: readJson<Report>(join(directory, "mutation.json")),
    files: new Set(readJson<readonly string[]>(join(directory, "files.json"))),
  }));
const merged = mergeReports({
  shards,
  previous: existsSync(previousPath) ? readJson<Report>(previousPath) : undefined,
  keep: mutateFiles(join("packages", name)),
});
writeFileSync(output, JSON.stringify(merged));

const { score, detected, valid, survived, noCoverage } = scoreOf(merged);
process.stdout.write(
  `Final mutation score of ${shards.length} of ${shardDirectories.length} shards: ${score.toFixed(2)} (${detected} of ${valid} mutants detected, ${survived} survived, ${noCoverage} without coverage)\n`,
);
