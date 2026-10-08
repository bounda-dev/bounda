import { describe, expect, it } from "vitest";
import { streamId } from "./event.ts";

describe("streamId", () => {
  it("joins aggregate type and id", () => {
    expect(streamId({ aggregateType: "order", aggregateId: "42" })).toBe("order:42");
  });
});
