import { describe, expect, it } from "vitest";
import { ValidationError } from "../../contracts/errors.ts";
import { checkIncludeRestricted, restrictedAmong, restrictionViewOf } from "./restricted-reads.ts";

describe("checkIncludeRestricted", () => {
  it("passes a basis of article 18(2) or none, and refuses anything else naming the option", () => {
    expect(checkIncludeRestricted("query orders", undefined)).toBeUndefined();
    expect(checkIncludeRestricted("query orders", "legal-claims")).toBe("legal-claims");
    expect(() => checkIncludeRestricted("query orders", "curiosity")).toThrow(ValidationError);
    expect(() => checkIncludeRestricted("query orders", "curiosity")).toThrow(
      expect.objectContaining({
        message: "query orders names a basis restricted data is not read on",
        issues: [
          {
            path: ["includeRestricted"],
            message:
              'Expected one of "consent", "legal-claims", "protection-of-rights", "public-interest", "legal-obligation"',
          },
        ],
      }),
    );
  });
});

describe("restrictionViewOf", () => {
  it("reads past what a forgetting kept on legal-obligation, past everything on another basis", () => {
    expect(restrictionViewOf(undefined)).toBe("unrestricted");
    expect(restrictionViewOf("legal-obligation")).toBe("retained");
    expect(restrictionViewOf("consent")).toBe("all");
  });
});

describe("restrictedAmong", () => {
  it("reads each person's restrictions once", async () => {
    const asked: string[] = [];
    const among = restrictedAmong({
      restrictions: async (person) => {
        asked.push(person);
        return person === "ana"
          ? [{ ground: "legal-claims", category: null, since: "2026-01-01T00:00:00.000Z" }]
          : [];
      },
    });
    expect(await among("ana")).toBe(true);
    expect(await among("bo")).toBe(false);
    expect(await among("ana")).toBe(true);
    expect(asked).toEqual(["ana", "bo"]);
  });
});
