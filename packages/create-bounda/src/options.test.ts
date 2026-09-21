import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager, type Prompts, projectNameOf, resolveOptions } from "./options.ts";

const answers = (text: string | null, select: string | null): Prompts & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    text: async (message) => {
      asked.push(message);
      return text;
    },
    select: async (message) => {
      asked.push(message);
      return select as never;
    },
  };
};

describe("detectPackageManager", () => {
  it("reads the package manager from the npm user agent and falls back to npm", () => {
    expect(detectPackageManager("pnpm/12.4.2 npm/? node/v25.2.1 darwin arm64")).toBe("pnpm");
    expect(detectPackageManager("yarn/4.9.1 npm/? node/v24.0.0")).toBe("yarn");
    expect(detectPackageManager("bun/1.3.0 npm/? node/v24")).toBe("bun");
    expect(detectPackageManager("npm/11.0.0 node/v24.0.0")).toBe("npm");
    expect(detectPackageManager(undefined)).toBe("npm");
    expect(detectPackageManager("deno/2.0")).toBe("npm");
  });
});

describe("projectNameOf", () => {
  it("derives a valid package name from the directory", () => {
    expect(projectNameOf("/tmp/My Shop")).toBe("my-shop");
    expect(projectNameOf("shop")).toBe("shop");
    expect(projectNameOf("./.hidden")).toBe("hidden");
    expect(projectNameOf("/tmp/___")).toBe("bounda-app");
  });
});

describe("resolveOptions", () => {
  const cwd = "/work";

  it("takes everything from the flags when given", async () => {
    const prompts = answers("ignored", "ignored");
    const options = await resolveOptions({
      raw: {
        directory: "shop",
        database: "postgresql",
        packageManager: "bun",
        install: false,
        git: true,
        yes: false,
      },
      cwd,
      userAgent: "pnpm/12",
      prompts,
    });
    expect(options).toEqual({
      directory: resolve(cwd, "shop"),
      name: "shop",
      database: "postgresql",
      packageManager: "bun",
      install: false,
      git: true,
    });
    expect(prompts.asked).toEqual([]);
  });

  it("asks for what is missing and trims the answer", async () => {
    const prompts = answers("  my shop  ", "postgresql");
    const options = await resolveOptions({
      raw: { install: true, git: true, yes: false },
      cwd,
      userAgent: "yarn/4",
      prompts,
    });
    expect(options).toMatchObject({
      directory: resolve(cwd, "my shop"),
      name: "my-shop",
      database: "postgresql",
      packageManager: "yarn",
    });
    expect(prompts.asked).toEqual(["Where should the project go?", "Which database?"]);
  });

  it("uses the defaults with --yes or without a terminal, including an empty answer", async () => {
    const yes = await resolveOptions({
      raw: { install: true, git: true, yes: true },
      cwd,
      userAgent: undefined,
      prompts: answers("nope", "postgresql"),
    });
    expect(yes).toMatchObject({ name: "bounda-app", database: "sqlite", packageManager: "npm" });
    const quiet = await resolveOptions({
      raw: { install: true, git: true, yes: false },
      cwd,
      userAgent: undefined,
      prompts: null,
    });
    expect(quiet).toMatchObject({ name: "bounda-app", database: "sqlite" });
    const empty = await resolveOptions({
      raw: { install: true, git: true, yes: false },
      cwd,
      userAgent: undefined,
      prompts: answers("   ", "sqlite"),
    });
    expect(empty).toMatchObject({ name: "bounda-app" });
  });

  it("reports a cancelled prompt", async () => {
    expect(
      await resolveOptions({
        raw: { install: true, git: true, yes: false },
        cwd,
        userAgent: undefined,
        prompts: answers(null, "sqlite"),
      }),
    ).toBe("cancelled");
    expect(
      await resolveOptions({
        raw: { directory: "x", install: true, git: true, yes: false },
        cwd,
        userAgent: undefined,
        prompts: answers("x", null),
      }),
    ).toBe("cancelled");
  });

  it("rejects unknown databases and package managers", async () => {
    await expect(
      resolveOptions({
        raw: { database: "mongo", install: true, git: true, yes: true },
        cwd,
        userAgent: undefined,
        prompts: null,
      }),
    ).rejects.toThrow('--database must be one of sqlite, postgresql; got "mongo"');
    await expect(
      resolveOptions({
        raw: { packageManager: "cargo", install: true, git: true, yes: true },
        cwd,
        userAgent: undefined,
        prompts: null,
      }),
    ).rejects.toThrow('--pm must be one of pnpm, npm, yarn, bun; got "cargo"');
  });
});
