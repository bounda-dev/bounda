import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { KvLedgerKey, KvLedgerPut } from "@bounda-dev/cloudflare/forget-ledger";

const run = promisify(execFile);

// Resolves what wrangler printed to stdout.
export interface Wrangler {
  (args: readonly string[]): Promise<string>;
}

export interface WranglerInFunction {
  (root: string): Wrangler;
}

const binOf = (packageJson: string): string => {
  const { bin } = JSON.parse(readFileSync(packageJson, "utf8")) as {
    readonly bin?: string | Readonly<Record<string, string>>;
  };
  const path = typeof bin === "string" ? bin : bin?.wrangler;
  if (path === undefined) throw new Error(`${packageJson} names no wrangler executable`);
  return resolve(dirname(packageJson), path);
};

// The package as the project installed it, in the `node_modules` of the root or a directory above.
const installedIn = (root: string, name: string): string | undefined => {
  for (let directory = resolve(root); ; ) {
    const packageJson = join(directory, "node_modules", name, "package.json");
    if (existsSync(packageJson)) return packageJson;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

// Through Node rather than a shell, so the `.cmd` shim it has on Windows is not needed; its stderr,
// where it reports progress, is left out.
export const wranglerIn: WranglerInFunction = (root) => {
  let bin: string | undefined;
  return async (args) => {
    if (bin === undefined) {
      const packageJson = installedIn(root, "wrangler");
      if (packageJson === undefined) {
        throw new Error(`wrangler is not installed in ${root}: add it to the project`);
      }
      bin = binOf(packageJson);
    }
    const { stdout } = await run(process.execPath, [bin, ...args], {
      cwd: root,
      maxBuffer: 1024 * 1024 * 1024,
    });
    return stdout;
  };
};

export interface WranglerTarget {
  readonly local: boolean;
  readonly env?: string | undefined;
  readonly config?: string | undefined;
  readonly persistTo?: string | undefined;
}

// The KV ledger's own package lays its keys out, so the plan comes from it.
export type KvLedgerModule = Pick<
  typeof import("@bounda-dev/cloudflare/forget-ledger"),
  "KV_FORGET_LEDGER_ROOT" | "planKvForgetLedgerExpiry"
>;

export interface ExpireKvLedgerArgs {
  readonly wrangler: Wrangler;
  readonly ledger: KvLedgerModule;
  readonly binding: string;
  readonly keepForMs: number;
  readonly target: WranglerTarget;
  readonly now: number;
}

export interface KvLedgerExpired {
  readonly expired: number;
  readonly removed: number;
}

export interface ExpireKvLedgerFunction {
  (args: ExpireKvLedgerArgs): Promise<KvLedgerExpired>;
}

const isListedKey = (value: unknown): value is KvLedgerKey =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "name") === "string" &&
  ["number", "undefined"].includes(typeof Reflect.get(value, "expiration"));

const holdsEntry = (value: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

export const expireKvLedger: ExpireKvLedgerFunction = async ({
  wrangler,
  ledger,
  binding,
  keepForMs,
  target,
  now,
}) => {
  const where = [
    target.local ? "--local" : "--remote",
    ...(target.env === undefined ? [] : ["--env", target.env]),
    ...(target.config === undefined ? [] : ["--config", target.config]),
    ...(target.persistTo === undefined ? [] : ["--persist-to", target.persistTo]),
  ];
  const listed: unknown = JSON.parse(
    await wrangler([
      "kv",
      "key",
      "list",
      "--binding",
      binding,
      "--prefix",
      ledger.KV_FORGET_LEDGER_ROOT,
      ...where,
    ]),
  );
  if (!Array.isArray(listed) || !listed.every(isListedKey)) {
    throw new Error("wrangler kv key list printed something else than a list of keys");
  }
  const plan = ledger.planKvForgetLedgerExpiry({ keys: listed, keepForMs, now });
  const { remove } = plan;
  // A key whose value holds the entry is written again with that value, one read at a time; a
  // value that is gone, which wrangler answers with a line of its own, leaves the key alone.
  const expire: KvLedgerPut[] = [];
  for (const put of plan.expire) {
    if (put.value !== null) {
      expire.push(put);
      continue;
    }
    const value = await wrangler([
      "kv",
      "key",
      "get",
      put.key,
      "--binding",
      binding,
      "--text",
      ...where,
    ]);
    if (holdsEntry(value)) expire.push({ ...put, value });
  }
  const directory = await mkdtemp(join(tmpdir(), "bounda-forget-ledger-"));
  try {
    if (expire.length > 0) {
      const file = join(directory, "expire.json");
      await writeFile(file, JSON.stringify(expire));
      await wrangler(["kv", "bulk", "put", file, "--binding", binding, ...where]);
    }
    if (remove.length > 0) {
      const file = join(directory, "remove.json");
      await writeFile(file, JSON.stringify(remove));
      await wrangler(["kv", "bulk", "delete", file, "--binding", binding, "--force", ...where]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { expired: expire.length, removed: remove.length };
};
