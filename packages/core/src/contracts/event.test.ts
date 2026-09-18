import { describe, expect, it } from "vitest";
import { PROCESS_STREAM_PREFIX, processStreamId, streamId } from "./event.ts";

describe("streamId", () => {
  it("joins aggregate type and id", () => {
    expect(streamId({ aggregateType: "order", aggregateId: "42" })).toBe("order:42");
  });
});

describe("processStreamId", () => {
  it("prefixes process streams so they never collide with aggregates", () => {
    const id = processStreamId({ processType: "OrderLifecycle", aggregateId: "42" });
    expect(id).toBe("process:OrderLifecycle:42");
    expect(id.startsWith(`${PROCESS_STREAM_PREFIX}:`)).toBe(true);
    expect(id).not.toBe(streamId({ aggregateType: "OrderLifecycle", aggregateId: "42" }));
  });
});
