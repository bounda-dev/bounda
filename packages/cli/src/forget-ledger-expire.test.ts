import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as ledger from "@bounda-dev/cloudflare/forget-ledger";
import { afterAll, describe, expect, it } from "vitest";
import { expireKvLedger, type Wrangler, wranglerIn } from "./forget-ledger-expire.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9);
const ROOT = ledger.KV_FORGET_LEDGER_ROOT;

const temporary: string[] = [];

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

const metadata = (daysAgo: number) => ({
  personId: "c-1",
  forgottenAt: new Date(NOW - daysAgo * DAY).toISOString(),
  reason: "requested",
});

// Answers the listing with `listed`, and keeps what each bulk command was handed.
const fakeWrangler = (listed: unknown) => {
  const calls: (readonly string[])[] = [];
  const files: unknown[] = [];
  const wrangler: Wrangler = async (args) => {
    calls.push(args);
    if (args[1] === "bulk") files.push(JSON.parse(await readFile(args[3] ?? "", "utf8")));
    return args[1] === "key" ? JSON.stringify(listed) : "";
  };
  return { wrangler, calls, files };
};

describe("expiring a KV forget ledger through wrangler", () => {
  it("writes again, with an expiration, the entries kept for good or too long, and removes those past keepFor", async () => {
    const { wrangler, calls, files } = fakeWrangler([
      { name: `${ROOT}t/1:e-1`, metadata: metadata(1) },
      { name: `${ROOT}t/2:e-2`, metadata: metadata(40) },
      { name: `${ROOT}t/3:e-3`, metadata: metadata(2), expiration: NOW / 1000 + 400 * 86_400 },
      { name: `${ROOT}t/4:e-4`, metadata: metadata(3), expiration: NOW / 1000 + 86_400 },
      { name: `${ROOT}t/5:e-5` },
    ]);
    const expired = await expireKvLedger({
      wrangler,
      ledger,
      binding: "FORGET_LEDGER",
      keepForMs: 35 * DAY,
      target: { local: false },
      now: NOW,
    });
    expect(expired).toEqual({ expired: 2, removed: 1 });
    // The files wrangler read are gone with their directory.
    for (const args of calls.slice(1)) expect(existsSync(dirname(args[3] ?? ""))).toBe(false);
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ["kv", "key", "list"],
      ["kv", "bulk", "put"],
      ["kv", "bulk", "delete"],
    ]);
    expect(calls[0]).toEqual([
      "kv",
      "key",
      "list",
      "--binding",
      "FORGET_LEDGER",
      "--prefix",
      ROOT,
      "--remote",
    ]);
    expect(calls[1]?.slice(4)).toEqual(["--binding", "FORGET_LEDGER", "--remote"]);
    expect(calls[2]?.slice(4)).toEqual(["--binding", "FORGET_LEDGER", "--force", "--remote"]);
    expect(files).toEqual([
      [
        {
          key: `${ROOT}t/1:e-1`,
          value: "",
          expiration: (NOW + 34 * DAY) / 1000,
          metadata: metadata(1),
        },
        {
          key: `${ROOT}t/3:e-3`,
          value: "",
          expiration: (NOW + 33 * DAY) / 1000,
          metadata: metadata(2),
        },
      ],
      [`${ROOT}t/2:e-2`],
    ]);
  });

  it("calls no bulk command when nothing changes, and names the target it was given", async () => {
    const { wrangler, calls } = fakeWrangler([]);
    expect(
      await expireKvLedger({
        wrangler,
        ledger,
        binding: "LEDGER",
        keepForMs: DAY,
        target: { local: true, env: "staging", config: "w.jsonc", persistTo: ".state" },
        now: NOW,
      }),
    ).toEqual({ expired: 0, removed: 0 });
    expect(calls).toEqual([
      [
        "kv",
        "key",
        "list",
        "--binding",
        "LEDGER",
        "--prefix",
        ROOT,
        "--local",
        "--env",
        "staging",
        "--config",
        "w.jsonc",
        "--persist-to",
        ".state",
      ],
    ]);
  });

  it("refuses a listing that is not a list of keys, changing nothing", async () => {
    for (const listed of [{}, [{ name: 3 }], [{ name: "k", expiration: "soon" }], [null], ["k"]]) {
      const { wrangler, calls } = fakeWrangler(listed);
      await expect(
        expireKvLedger({
          wrangler,
          ledger,
          binding: "LEDGER",
          keepForMs: DAY,
          target: { local: true },
          now: NOW,
        }),
      ).rejects.toThrow("wrangler kv key list printed something else than a list of keys");
      expect(calls).toHaveLength(1);
    }
  });

  it("says wrangler is missing from a project without it, or installed without its executable", async () => {
    const root = await mkdtemp(join(tmpdir(), "bounda-no-wrangler-"));
    temporary.push(root);
    await expect(wranglerIn(root)(["--version"])).rejects.toThrow(
      `wrangler is not installed in ${root}: add it to the project`,
    );
    const nested = join(root, "app", "nested");
    await mkdir(join(root, "node_modules", "wrangler"), { recursive: true });
    await mkdir(nested, { recursive: true });
    const packageJson = join(root, "node_modules", "wrangler", "package.json");
    await writeFile(packageJson, JSON.stringify({ name: "wrangler" }));
    await expect(wranglerIn(nested)(["--version"])).rejects.toThrow(
      `${packageJson} names no wrangler executable`,
    );
    await writeFile(packageJson, JSON.stringify({ name: "wrangler", bin: "cli.js" }));
    await writeFile(join(root, "node_modules", "wrangler", "cli.js"), 'console.log("4.0.0");');
    expect(await wranglerIn(nested)(["--version"])).toBe("4.0.0\n");
    await writeFile(
      packageJson,
      JSON.stringify({ name: "wrangler", bin: { wrangler: "cli.js", wrangler2: "other.js" } }),
    );
    expect(await wranglerIn(root)(["--version"])).toBe("4.0.0\n");
  });

  it("gives the entries in wrangler's local state their expiration, as the deployed namespace would get them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bounda-kv-expire-"));
    temporary.push(directory);
    const config = join(directory, "wrangler.jsonc");
    await writeFile(
      config,
      JSON.stringify({
        name: "kv-expire",
        compatibility_date: "2025-10-08",
        kv_namespaces: [{ binding: "FORGET_LEDGER", id: "forget-ledger" }],
      }),
    );
    const where = ["--local", "--config", config, "--persist-to", join(directory, "state")];
    const wrangler = wranglerIn(resolve(import.meta.dirname, ".."));
    const now = Date.now();
    const seeded = join(directory, "seeded.json");
    const at = (daysAgo: number) => ({
      personId: "c-1",
      forgottenAt: new Date(now - daysAgo * DAY).toISOString(),
      reason: "requested",
    });
    await writeFile(
      seeded,
      JSON.stringify([
        { key: `${ROOT}t/1:e-1`, value: "", metadata: at(1) },
        { key: `${ROOT}t/2:e-2`, value: "", metadata: at(40) },
        { key: "elsewhere", value: "kept" },
      ]),
    );
    await wrangler(["kv", "bulk", "put", seeded, "--binding", "FORGET_LEDGER", ...where]);
    const expired = await expireKvLedger({
      wrangler,
      ledger,
      binding: "FORGET_LEDGER",
      keepForMs: 35 * DAY,
      target: { local: true, config, persistTo: join(directory, "state") },
      now,
    });
    expect(expired).toEqual({ expired: 1, removed: 1 });
    const listed = JSON.parse(
      await wrangler(["kv", "key", "list", "--binding", "FORGET_LEDGER", ...where]),
    ) as readonly { readonly name: string; readonly expiration?: number }[];
    expect(listed.map(({ name, expiration }) => [name, expiration])).toEqual([
      [`${ROOT}t/1:e-1`, Math.ceil((now + 34 * DAY) / 1000)],
      ["elsewhere", undefined],
    ]);
  }, 120_000);
});
