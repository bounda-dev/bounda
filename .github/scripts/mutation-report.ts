// Merges the mutation reports of a package's shards into one, as a run of the whole package
// writes it, and prints its score: `node .github/scripts/mutation-report.ts <merged.json>
// <shard.json>...`. Each shard mutates other files, so their reports only add up.
import { readFileSync, writeFileSync } from "node:fs";

interface Report {
  readonly files: Readonly<
    Record<string, { readonly mutants: readonly { readonly status: string }[] }>
  >;
}

const [output = "", ...inputs] = process.argv.slice(2);
if (output === "" || inputs.length === 0) {
  throw new Error("usage: mutation-report.ts <merged.json> <shard.json>...");
}
const reports = inputs.map((input) => JSON.parse(readFileSync(input, "utf8")) as Report);
const [first] = reports;
const merged = { ...first, files: Object.assign({}, ...reports.map(({ files }) => files)) };
writeFileSync(output, JSON.stringify(merged));

// The score Stryker reports: detected mutants over those the tests could have detected.
const count = new Map<string, number>();
for (const { mutants } of Object.values(merged.files as Report["files"])) {
  for (const { status } of mutants) count.set(status, (count.get(status) ?? 0) + 1);
}
const of = (status: string): number => count.get(status) ?? 0;
const detected = of("Killed") + of("Timeout");
const valid = detected + of("Survived") + of("NoCoverage");
const score = valid === 0 ? 100 : (detected / valid) * 100;
process.stdout.write(
  `Final mutation score of ${inputs.length} shards: ${score.toFixed(2)} (${detected} of ${valid} mutants detected, ${of("Survived")} survived, ${of("NoCoverage")} without coverage)\n`,
);
