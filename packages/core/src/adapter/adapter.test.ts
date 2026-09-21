import { describe, expect, it } from "vitest";
import { memory } from "../memory/index.ts";
import { isAdapter } from "./adapter.ts";

describe("isAdapter", () => {
  it("accepts a definition that carries both factories", () => {
    expect(isAdapter(memory())).toBe(true);
  });

  it("rejects anything that is not an adapter object", () => {
    const adapter = memory();
    expect(isAdapter(undefined)).toBe(false);
    expect(isAdapter(null)).toBe(false);
    expect(isAdapter("sqlite")).toBe(false);
    expect(isAdapter({ ...adapter, kind: "bounda-plugin" })).toBe(false);
    expect(isAdapter({ ...adapter, createStorage: undefined })).toBe(false);
    expect(isAdapter({ ...adapter, createReadModel: "later" })).toBe(false);
    expect(isAdapter({ kind: "bounda-adapter", name: "sqlite", options: {} })).toBe(false);
  });
});
