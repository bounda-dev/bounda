import { describe, expect, it } from "vitest";
import { fieldBuilder as f } from "./view.ts";

describe("fieldBuilder", () => {
  it("creates plain fields with every flag off", () => {
    expect(f.string()).toMatchObject({
      type: "string",
      isOptional: false,
      isPrimaryKey: false,
      isUnique: false,
      isIndexed: false,
    });
    expect(f.number().type).toBe("number");
    expect(f.boolean().type).toBe("boolean");
    expect(f.date().type).toBe("date");
    expect(f.json<{ tags: string[] }>().type).toBe("json");
  });

  it("returns a new field on every modifier and never mutates the original", () => {
    const base = f.string();
    const key = base.primaryKey();
    const optionalIndexed = base.optional().index();
    expect(base.isPrimaryKey).toBe(false);
    expect(key.isPrimaryKey).toBe(true);
    expect(key.isOptional).toBe(false);
    expect(optionalIndexed).toMatchObject({
      isOptional: true,
      isIndexed: true,
      isPrimaryKey: false,
    });
    expect(f.string().unique().isUnique).toBe(true);
  });
});
