import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCommand, realExec, runCommand } from "./steps.ts";

describe("realExec", () => {
  it("runs a package manager, a `.cmd` shim on Windows, in the directory it is given", async () => {
    await expect(realExec("npm", ["--version"], tmpdir())).resolves.toBeUndefined();
    await expect(realExec("npm", ["no-such-command"], tmpdir())).rejects.toThrow();
    await expect(
      realExec("npm", ["--version"], join(tmpdir(), "create-bounda-no-such-directory")),
    ).rejects.toThrow();
  });

  it("refuses what the shell would split or interpret", async () => {
    await expect(realExec("npm", ["--version", "a b"], tmpdir())).rejects.toThrow(
      'refusing to pass "a b" through the shell',
    );
    await expect(realExec("npm;", ["--version"], tmpdir())).rejects.toThrow(
      'refusing to pass "npm;" through the shell',
    );
  });
});

describe("installCommand", () => {
  it("knows how each package manager installs", () => {
    expect(installCommand("pnpm")).toEqual(["pnpm", ["install"]]);
    expect(installCommand("npm")).toEqual(["npm", ["install"]]);
    expect(installCommand("bun")).toEqual(["bun", ["install"]]);
    expect(installCommand("yarn")).toEqual(["yarn", []]);
  });
});

describe("runCommand", () => {
  it("spells scripts the way each package manager expects", () => {
    expect(runCommand("pnpm", "install")).toBe("pnpm install");
    expect(runCommand("yarn", "install")).toBe("yarn");
    expect(runCommand("npm", "test")).toBe("npm test");
    expect(runCommand("npm", "start")).toBe("npm start");
    expect(runCommand("npm", "generate")).toBe("npm run generate");
    expect(runCommand("bun", "test")).toBe("bun run test");
    expect(runCommand("pnpm", "dev")).toBe("pnpm dev");
    expect(runCommand("yarn", "start")).toBe("yarn start");
  });
});
