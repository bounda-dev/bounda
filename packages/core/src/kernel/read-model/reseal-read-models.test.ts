import { describe, expect, it, vi } from "vitest";
import { RebuildSupersededError } from "../../contracts/errors.ts";
import { rebuiltMark } from "./rebuild.ts";
import { createResealReadModels } from "./reseal-read-models.ts";

const readModel = (name: string, personal: number, rebuiltAt = 0) => ({
  name,
  layout: { personal: Array.from({ length: personal }) as never },
  storage: {
    checkpointStore: {
      get: async (subscriber: string) => (subscriber === rebuiltMark(name) ? rebuiltAt : 0),
    } as never,
  },
});

describe("createResealReadModels", () => {
  it("rebuilds, a slice a call, each read model holding personal data not rebuilt past the position", async () => {
    const rebuild = vi.fn(async () => undefined);
    const readModels = createResealReadModels({
      readModels: [readModel("plans", 0), readModel("done", 1, 7), readModel("customers", 1, 6)],
      rebuild,
      maxEvents: 250,
    });
    expect(await readModels.advance(7)).toBe("progressed");
    expect(rebuild.mock.calls).toEqual([["customers", { maxEvents: 250 }]]);
    expect(await readModels.advance(6)).toBe("ready");
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("goes on past a rebuild another took over, and fails with any other error", async () => {
    const superseded = createResealReadModels({
      readModels: [readModel("customers", 1)],
      rebuild: async () => {
        throw new RebuildSupersededError("customers");
      },
      maxEvents: 10,
    });
    expect(await superseded.advance(1)).toBe("progressed");
    const failing = createResealReadModels({
      readModels: [readModel("customers", 1)],
      rebuild: async () => {
        throw new Error("projection failed");
      },
      maxEvents: 10,
    });
    await expect(failing.advance(1)).rejects.toThrow("projection failed");
  });
});
