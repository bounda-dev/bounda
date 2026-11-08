import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { memory } from "../../memory/index.ts";
import { buildAggregates } from "../aggregate/build-aggregates.ts";
import { generatePersonalKey } from "../personal-data/crypto.ts";
import type { KeyWrapper } from "../personal-data/key-wrapper.ts";
import { createPersonalKeyWrapping } from "../personal-data/wrapped-keys.ts";
import { appStorage } from "./app-event-store.ts";

const setUp = async () => {
  const unwrapped: string[] = [];
  const wrapper: KeyWrapper = {
    kid: "kid-1",
    wrap: async (key) => key,
    unwrap: async ({ kid, wrapped }) => {
      unwrapped.push(kid);
      return wrapped;
    },
  };
  const written = await memory().createStorage();
  const wrapping = createPersonalKeyWrapping({ wrapper, clock: createFixedClock() });
  const storage = appStorage({
    storage: written,
    aggregates: buildAggregates({ registry: { aggregates: {}, readModels: {} }, ports: {} }),
    processes: { byName: {} },
    wrapping,
  });
  await storage.personalKeys.add("c-1", await generatePersonalKey());
  const stored = await written.personalKeys.get("c-1");
  if (stored === null) throw new Error("no key stored");
  return { unwrapped, wrapping, storage, stored };
};

describe("appStorage", () => {
  it("drops a key a transaction removes once it commits, even one unwrapped again meanwhile", async () => {
    const { unwrapped, wrapping, storage, stored } = await setUp();
    expect(unwrapped).toHaveLength(1);
    await storage.transact(async (transaction) => {
      await transaction.personalKeys.remove("c-1");
      // A read that started before the removal, as a projection's, unwraps the key again.
      await wrapping.unwrapped(stored, "c-1");
    });
    expect(unwrapped).toHaveLength(2);
    await wrapping.wrapped(stored);
    expect(unwrapped).toHaveLength(3);
  });

  it("keeps a key whose removal did not commit", async () => {
    const { unwrapped, wrapping, storage, stored } = await setUp();
    await expect(
      storage.transact(async (transaction) => {
        await transaction.personalKeys.remove("c-1");
        await wrapping.unwrapped(stored, "c-1");
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    await wrapping.wrapped(stored);
    expect(unwrapped).toHaveLength(2);
  });
});
