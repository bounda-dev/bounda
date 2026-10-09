import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { packDocs } from "./pack.ts";

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const { version } = JSON.parse(await readFile(at("../../package.json"), "utf8")) as {
  readonly version: string;
};
const files = await packDocs({
  source: at("../../../../docs/src/content/docs"),
  target: at("../../docs"),
  version,
  site: "https://docs.bounda.dev",
});
process.stdout.write(`packed ${files.length} docs pages into docs/\n`);
