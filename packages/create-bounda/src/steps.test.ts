import { describe, expect, it } from "vitest";
import { installCommand, runCommand } from "./steps.ts";

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
