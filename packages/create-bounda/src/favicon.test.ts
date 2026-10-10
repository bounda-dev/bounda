import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../..");

const COPIES = [
  "packages/create-bounda/template/react-router/public",
  "examples/onboarding/public",
];

describe("favicon", () => {
  it.each(
    COPIES.flatMap((directory) => ["favicon.svg", "favicon.ico"].map((file) => [directory, file])),
  )("%s/%s is the docs' favicon", async (directory, file) => {
    const [copy, original] = await Promise.all([
      readFile(resolve(ROOT, directory, file)),
      readFile(resolve(ROOT, "docs/public", file)),
    ]);

    expect(copy.equals(original)).toBe(true);
  });
});
