import { describe, expect, it, vi } from "vitest";
import { EXIT_FAILURE, runCli } from "./run.ts";

// A project that never installed the package the KV ledger comes from.
vi.mock("@bounda-dev/cloudflare/forget-ledger", () => {
  throw new Error("Cannot find package '@bounda-dev/cloudflare'");
});

describe("bounda forget-ledger expire without @bounda-dev/cloudflare", () => {
  it("says the package is missing, and runs no wrangler", async () => {
    let stderr = "";
    let runs = 0;
    const code = await runCli({
      argv: ["forget-ledger", "expire", "--binding", "L", "--keep-for", "35d"],
      cwd: "/project",
      stdout: { write: () => undefined },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
      wrangler: () => async () => {
        runs += 1;
        return "[]";
      },
    });
    expect(code).toBe(EXIT_FAILURE);
    expect(stderr).toBe(
      "error: @bounda-dev/cloudflare is not installed, and the KV forget ledger comes from it\n",
    );
    expect(runs).toBe(0);
  });
});
