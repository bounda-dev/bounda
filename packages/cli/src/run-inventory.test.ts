import { resolve } from "node:path";
import type { PersonalDataInventory } from "@bounda-dev/core";
import { describe, expect, it } from "vitest";
import { EXIT_CONVENTION, EXIT_FAILURE, EXIT_OK, runCli } from "./run.ts";

const fixture = resolve(import.meta.dirname, "fixtures/inventory-project");

const cli = async (argv: readonly string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli({
    argv,
    cwd: fixture,
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => err.push(text) },
  });
  return { code, stdout: out.join(""), stderr: err.join("") };
};

describe("bounda personal-data inventory", () => {
  it("prints the record and exits 0 when every field is classified", async () => {
    const { code, stdout } = await cli(["personal-data", "inventory"]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("Personal data inventory (GDPR article 30)");
    expect(stdout).toContain("  contact  consent  forgotten 730d after last activity  2 fields");
    expect(stdout).toContain("  event customer.CustomerRegistered, of the aggregate's id");
    expect(stdout).toContain("    email  contact  sealed under the person's key");
    expect(stdout).toContain("  read model customers, of the person in customerId");
    expect(stdout).toContain("  event customer.CustomerRegistered: plan");
    expect(stdout).toContain("Complete: every field is classified");
  });

  it("prints it as JSON", async () => {
    const { code, stdout } = await cli(["personal-data", "inventory", "--json"]);
    expect(code).toBe(EXIT_OK);
    const inventory = JSON.parse(stdout) as PersonalDataInventory;
    expect(inventory.holders.map(({ name }) => name)).toEqual([
      "customer.CustomerRegistered",
      "customers",
    ]);
    expect(inventory.findings).toEqual([]);
  });

  it("prints it as a Markdown document", async () => {
    const { code, stdout } = await cli(["personal-data", "inventory", "--markdown"]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^# Record of processing activities\n/);
    expect(stdout).toContain(
      "| event `customer.CustomerRegistered` | `email` | contact | the aggregate's id | sealed under the person's key | event store (memory) |",
    );
    expect(stdout).toContain("None: every field is classified.");
  });

  it("exits 1 while a field is not classified or looks personal unmarked", async () => {
    const { code, stdout } = await cli([
      "personal-data",
      "inventory",
      "--registry",
      ".bounda/unclassified-registry.ts",
    ]);
    expect(code).toBe(EXIT_CONVENTION);
    expect(stdout).toContain(
      'customer.CustomerNoted: field "phone" is named like personal data ("phone") and is not marked; mark it personal or notPersonal',
    );
    expect(stdout).toContain('customer.CustomerNoted: field "age"');
    expect(stdout).toMatch(/\n2 findings\n$/);
  });

  it("says what it does in its help", async () => {
    const { stdout } = await cli(["personal-data", "--help"]);
    expect(stdout).toContain("describe the personal data the app processes");
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "print the record of processing activities (GDPR article 30) the modules and the configuration describe, and exit 1 while a field is not classified or looks personal unmarked",
    );
    const inventory = await cli(["personal-data", "inventory", "--help"]);
    expect(inventory.stdout).toContain("--json");
    expect(inventory.stdout).toContain("print it as JSON");
    expect(inventory.stdout).toContain("print it as a Markdown document");
  });

  it("refuses --json with --markdown, as any misuse", async () => {
    const { code, stderr } = await cli(["personal-data", "inventory", "--json", "--markdown"]);
    expect(code).toBe(EXIT_CONVENTION);
    expect(stderr).toContain("cannot be used with option '--markdown'");
  });

  it("exits 2 when the project does not load", async () => {
    const { code, stderr } = await cli([
      "personal-data",
      "inventory",
      "--registry",
      ".bounda/missing.ts",
    ]);
    expect(code).toBe(EXIT_FAILURE);
    expect(stderr).toContain("error: Cannot find");
  });
});
