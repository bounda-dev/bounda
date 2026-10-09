import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  OFFER_CLOUDFLARE,
  type Prompts,
  projectNameOf,
  type RawOptions,
  resolveOptions,
} from "./options.ts";

interface Offered {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

interface Answers {
  readonly directory?: string | null;
  readonly runtime?: string | null;
  readonly framework?: string | null;
  readonly database?: string | null;
}

const QUESTIONS: Readonly<Record<string, keyof Answers>> = {
  "Where should the project go?": "directory",
  "Where will the app run?": "runtime",
  "Which framework?": "framework",
  "Which database?": "database",
};

// Answers each question by its message; a question it has no answer for is a test failure.
const answers = (
  given: Answers,
): Prompts & { asked: string[]; offered: Record<string, readonly Offered[]> } => {
  const asked: string[] = [];
  const offered: Record<string, readonly Offered[]> = {};
  const answer = (message: string): string | null => {
    asked.push(message);
    const key = QUESTIONS[message];
    if (key === undefined || !(key in given)) throw new Error(`unexpected question: ${message}`);
    return given[key] ?? null;
  };
  return {
    asked,
    offered,
    text: async (message) => answer(message),
    select: async (message, options) => {
      offered[message] = options;
      return answer(message) as never;
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
  const resolveWith = (raw: Partial<RawOptions>, prompts: Prompts | null = null) =>
    resolveOptions({
      raw: { install: true, git: true, yes: false, ...raw },
      cwd,
      userAgent: undefined,
      prompts,
    });

  it("takes everything from the flags when given", async () => {
    const prompts = answers({});
    const options = await resolveOptions({
      raw: {
        directory: "shop",
        runtime: "node",
        framework: "react-router",
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
      runtime: "node",
      framework: "react-router",
      database: "postgresql",
      packageManager: "bun",
      install: false,
      git: true,
    });
    expect(prompts.asked).toEqual([]);
  });

  it("asks for what is missing, runtime first, and trims the answer", async () => {
    const prompts = answers({
      directory: "  my shop  ",
      runtime: "node",
      framework: "react-router",
      database: "postgresql",
    });
    const options = await resolveOptions({
      raw: { install: true, git: true, yes: false },
      cwd,
      userAgent: "yarn/4",
      prompts,
    });
    expect(options).toMatchObject({
      directory: resolve(cwd, "my shop"),
      name: "my-shop",
      runtime: "node",
      framework: "react-router",
      database: "postgresql",
      packageManager: "yarn",
    });
    expect(prompts.asked).toEqual([
      "Where should the project go?",
      "Where will the app run?",
      "Which framework?",
      "Which database?",
    ]);
  });

  it("offers each runtime, framework and database with what it is for", async () => {
    const prompts = answers({
      directory: "shop",
      runtime: "node",
      framework: "none",
      database: "sqlite",
    });
    await resolveWith({}, prompts);
    expect(OFFER_CLOUDFLARE).toBe(true);
    expect(prompts.offered).toEqual({
      "Where will the app run?": [
        { value: "node", label: "Node", hint: "your own server, a container or a script" },
        {
          value: "cloudflare",
          label: "Cloudflare",
          hint: "a Worker and a Durable Object per tenant, no server",
        },
      ],
      "Which framework?": [
        { value: "none", label: "None", hint: "a script that boots the app" },
        { value: "react-router", label: "React Router", hint: "framework mode, Vite" },
      ],
      "Which database?": [
        { value: "sqlite", label: "SQLite", hint: "a file, no server; also Turso" },
        { value: "postgresql", label: "PostgreSQL", hint: "for several instances" },
      ],
    });
  });

  it("gives Cloudflare its Durable Object for a database, without asking for one", async () => {
    const prompts = answers({ directory: "edge", runtime: "cloudflare", framework: "none" });
    expect(await resolveWith({}, prompts)).toMatchObject({
      runtime: "cloudflare",
      framework: "none",
      database: "durable-object",
    });
    expect(prompts.asked).toEqual([
      "Where should the project go?",
      "Where will the app run?",
      "Which framework?",
    ]);
    expect(prompts.offered["Which framework?"]?.[0]).toEqual({
      value: "none",
      label: "None",
      hint: "a JSON API in the Worker",
    });
    expect(
      await resolveWith({ runtime: "cloudflare", framework: "react-router", yes: true }),
    ).toMatchObject({
      runtime: "cloudflare",
      framework: "react-router",
      database: "durable-object",
    });
  });

  it("refuses a database with Cloudflare", async () => {
    await expect(
      resolveWith({ runtime: "cloudflare", database: "sqlite", yes: true }),
    ).rejects.toThrow(
      "--database does not apply to --runtime cloudflare: the app keeps everything in its Durable Object's SQLite",
    );
  });

  it("runs on Node when given a database, without asking where", async () => {
    const prompts = answers({ framework: "none" });
    expect(await resolveWith({ directory: "shop", database: "postgresql" }, prompts)).toMatchObject(
      { runtime: "node", framework: "none", database: "postgresql" },
    );
    expect(prompts.asked).toEqual(["Which framework?"]);
  });

  it("uses the defaults with --yes or without a terminal, including an empty answer", async () => {
    const yes = await resolveOptions({
      raw: { install: true, git: true, yes: true },
      cwd,
      userAgent: undefined,
      prompts: answers({}),
    });
    expect(yes).toMatchObject({
      name: "bounda-app",
      runtime: "node",
      framework: "none",
      database: "sqlite",
      packageManager: "npm",
    });
    expect(await resolveWith({})).toMatchObject({
      name: "bounda-app",
      runtime: "node",
      framework: "none",
      database: "sqlite",
    });
    const empty = await resolveWith(
      {},
      answers({ directory: "   ", runtime: "node", framework: "none", database: "sqlite" }),
    );
    expect(empty).toMatchObject({ name: "bounda-app" });
  });

  it("reports a cancelled prompt", async () => {
    expect(await resolveWith({}, answers({ directory: null }))).toBe("cancelled");
    expect(await resolveWith({ directory: "x" }, answers({ runtime: null }))).toBe("cancelled");
    expect(
      await resolveWith({ directory: "x", runtime: "node" }, answers({ framework: null })),
    ).toBe("cancelled");
    expect(
      await resolveWith(
        { directory: "x", runtime: "node", framework: "none" },
        answers({ database: null }),
      ),
    ).toBe("cancelled");
  });

  it("rejects unknown runtimes, frameworks, databases and package managers", async () => {
    await expect(resolveWith({ runtime: "deno", yes: true })).rejects.toThrow(
      '--runtime must be one of node, cloudflare; got "deno"',
    );
    await expect(resolveWith({ framework: "next", yes: true })).rejects.toThrow(
      '--framework must be one of none, react-router; got "next"',
    );
    await expect(resolveWith({ database: "mongo", yes: true })).rejects.toThrow(
      '--database must be one of sqlite, postgresql; got "mongo"',
    );
    await expect(resolveWith({ database: "durable-object", yes: true })).rejects.toThrow(
      '--database must be one of sqlite, postgresql; got "durable-object"',
    );
    await expect(resolveWith({ packageManager: "cargo", yes: true })).rejects.toThrow(
      '--pm must be one of pnpm, npm, yarn, bun; got "cargo"',
    );
  });
});
