import { describe, expect, it } from "vitest";
import { appendLines, mergeManifest, resolveCatalog } from "./transform.ts";

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

describe("resolveCatalog", () => {
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
