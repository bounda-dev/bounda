import { describe, expect, it } from "vitest";
import {
  alignVersions,
  appendLines,
  mergeManifest,
  pinExact,
  resolveCatalog,
  setCompatibilityDate,
  syncpackPins,
  targetCompatibilityDate,
} from "./transform.ts";

describe("mergeManifest", () => {
  it("merges objects key by key, puts description after name and sorts dependencies", () => {
    const merged = mergeManifest(
      {
        name: "app",
        private: true,
        scripts: { dev: "wrangler dev" },
        devDependencies: { wrangler: "^4", typescript: "^7" },
        files: ["a"],
      },
      {
        description: "An app",
        scripts: { "test:e2e": "playwright test" },
        devDependencies: { "@playwright/test": "^1.63.0" },
        files: ["b"],
        cloudflare: { label: "App" },
      },
    );
    expect(Object.keys(merged)).toEqual([
      "name",
      "description",
      "private",
      "scripts",
      "devDependencies",
      "files",
      "cloudflare",
    ]);
    expect(merged.scripts).toEqual({ dev: "wrangler dev", "test:e2e": "playwright test" });
    expect(Object.keys(merged.devDependencies as object)).toEqual([
      "@playwright/test",
      "typescript",
      "wrangler",
    ]);
    expect(merged.files).toEqual(["b"]);
  });

  it("leaves a manifest without description or dependencies as it is", () => {
    expect(Object.keys(mergeManifest({ name: "app", version: "1.0.0" }, {}))).toEqual([
      "name",
      "version",
    ]);
  });

  it("replaces an object with a value that is not one, and keeps other objects' key order", () => {
    const merged = mergeManifest(
      { name: "app", files: { a: 1 }, scripts: { z: "last", a: "first" } },
      { files: "all" },
    );
    expect(merged.files).toBe("all");
    expect(Object.keys(merged.scripts as object)).toEqual(["z", "a"]);
  });
});

describe("resolveCatalog and pinExact", () => {
  it("turns catalog specifiers into caret ranges and leaves the rest", () => {
    const manifest = resolveCatalog(
      { dependencies: { a: "catalog:" }, devDependencies: { b: "^2.0.0", c: "catalog:" } },
      (name) => (name === "a" ? "1.0.0" : "3.1.4"),
    );
    expect(manifest).toEqual({
      dependencies: { a: "^1.0.0" },
      devDependencies: { b: "^2.0.0", c: "^3.1.4" },
    });
  });

  it("drops caret and tilde operators at the start of a specifier only", () => {
    expect(
      pinExact({
        dependencies: { a: "^1.0.0", b: "~2.0.0", c: "3.0.0", d: "npm:e@^4.0.0" },
        scripts: { x: "^y" },
      }),
    ).toEqual({
      dependencies: { a: "1.0.0", b: "2.0.0", c: "3.0.0", d: "npm:e@^4.0.0" },
      scripts: { x: "^y" },
    });
  });

  it("leaves a dependency field that is not a map alone", () => {
    expect(pinExact({ dependencies: null, devDependencies: ["a"] })).toEqual({
      dependencies: null,
      devDependencies: ["a"],
    });
  });
});

describe("alignVersions", () => {
  it("prefers a pin for the package, then the version most neighbours use, then its own", () => {
    const aligned = alignVersions({
      manifest: {
        dependencies: { "@bounda-dev/core": "0.1.0" },
        devDependencies: { typescript: "7.0.2", vitest: "4.1.11", wrangler: "4.200.0" },
      },
      neighbours: [
        { devDependencies: { typescript: "5.9.3", vitest: "3.2.7", wrangler: "4.136.1" } },
        { devDependencies: { typescript: "5.9.3", vitest: "4.1.10" } },
        { dependencies: { vitest: "4.1.10" } },
      ],
      pinned: { typescript: "7.0.2" },
    });
    expect(aligned).toEqual({
      dependencies: { "@bounda-dev/core": "0.1.0" },
      devDependencies: { typescript: "7.0.2", vitest: "4.1.10", wrangler: "4.136.1" },
    });
  });
});

describe("syncpackPins", () => {
  it("collects the pinned versions of the groups that name the package, first group first", () => {
    const pins = syncpackPins({
      packageName: "bounda-event-sourcing-template",
      config: {
        versionGroups: [
          {
            packages: ["bounda-event-sourcing-template"],
            dependencies: ["typescript"],
            pinVersion: "7.0.2",
          },
          { packages: ["other-template"], dependencies: ["zod"], pinVersion: "3.25.67" },
          { packages: ["*"], dependencies: ["vite"], pinVersion: "^7.0.0" },
          {
            packages: ["bounda-event-sourcing-template"],
            dependencies: ["typescript", 42],
            pinVersion: "5.9.3",
          },
          { packages: ["bounda-event-sourcing-template"], dependencies: ["vite"] },
          "not a group",
        ],
      },
    });
    expect(Object.entries(pins)).toEqual([["typescript", "7.0.2"]]);
    expect(syncpackPins({ packageName: "x", config: {} })).toEqual({});
  });
});

describe("compatibility dates", () => {
  it("rewrites the date of a wrangler.jsonc and nothing else", () => {
    const wrangler = '{\n  // a comment\n  "compatibility_date": "2026-09-21",\n  "name": "x"\n}\n';
    expect(setCompatibilityDate(wrangler, "2025-10-08")).toBe(
      '{\n  // a comment\n  "compatibility_date": "2025-10-08",\n  "name": "x"\n}\n',
    );
    expect(() => setCompatibilityDate("{}", "2025-10-08")).toThrow("no compatibility_date");
  });

  it("reads the date the templates linter requires", () => {
    expect(targetCompatibilityDate('const TARGET_COMPATIBILITY_DATE = "2025-10-08";')).toBe(
      "2025-10-08",
    );
    expect(targetCompatibilityDate('TARGET_COMPATIBILITY_DATE="2024-01-02"')).toBe("2024-01-02");
    expect(() => targetCompatibilityDate("const OTHER = 1;")).toThrow("not found");
  });
});

describe("appendLines", () => {
  it("adds the lines a file lacks, once, after its last line", () => {
    expect(appendLines("a\nb\n", ["b", "c", "d"])).toBe("a\nb\nc\nd\n");
    expect(appendLines("a\nb", ["c"])).toBe("a\nb\nc\n");
    expect(appendLines("a\n\n\n", ["c"])).toBe("a\nc\n");
    expect(appendLines("a\n", ["a"])).toBe("a\n");
    expect(appendLines("node_modules/\n", ["node_modules/"])).toBe("node_modules/\n");
  });
});
