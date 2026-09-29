import { describe, expect, it } from "vitest";
import { createKernelHarness } from "../test-support.ts";
import { createCommandsFacade } from "./facade.ts";

describe("createCommandsFacade", () => {
  it("exposes one function per command key that hands its command to dispatch", async () => {
    const { aggregates, pipeline, storage } = await createKernelHarness();
    const commands = createCommandsFacade({
      aggregates,
      dispatch: (command) => pipeline.dispatch(command),
    });
    expect(Object.keys(commands).sort()).toEqual([
      "archiveOrder",
      "breakOrder",
      "payOrder",
      "placeOrder",
      "touchOrder",
    ]);
    const result = await commands.placeOrder?.({ orderId: "o-1", total: 3 });
    expect(result).toMatchObject({ scheduled: false, version: 1 });
    const loaded = await storage.eventStore.load({ aggregateType: "order", aggregateId: "o-1" });
    expect(loaded.events[0]?.metadata.depth).toBe(0);
  });

  it("passes dispatch options through", async () => {
    const { aggregates, pipeline } = await createKernelHarness();
    const commands = createCommandsFacade({
      aggregates,
      dispatch: (command) => pipeline.dispatch(command),
    });
    const result = await commands.placeOrder?.({ orderId: "o-1", total: 3 }, { delay: "1m" });
    expect(result).toMatchObject({ scheduled: true, executeAt: "2026-01-01T00:01:00.000Z" });
  });
});
