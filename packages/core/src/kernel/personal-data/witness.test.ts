import { describe, expect, it } from "vitest";
import type { StoredPersonalKey } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import { createKeptPersonalKeyStore } from "../../memory/personal-key-store.ts";
import { witnessedWrapping } from "./witness.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const key = (name: string): StoredPersonalKey => ({
  key: `k-${name}`,
  fingerprint: `f-${name}`,
  kid: null,
});

describe("a witnessed key wrapping", () => {
  it("tells of every key it hands out unwrapped, and of none it does not have", async () => {
    const told: [string, StoredPersonalKey][] = [];
    const wrapping = witnessedWrapping(
      createPersonalKeyWrapping({ wrapper: null, clock: createFixedClock() }),
      {
        onPersonalKey: (person, held) => {
          told.push([person, held]);
        },
        onForgetLedger: () => {},
      },
    );
    const keys = wrapping.over(createKeptPersonalKeyStore().store);
    expect(await keys.get("c-1")).toBeNull();
    expect(await keys.add("c-1", key("1"))).toEqual(key("1"));
    expect(await keys.get("c-1")).toEqual(key("1"));
    expect(await wrapping.unwrapped(key("2"), "c-2")).toEqual(key("2"));
    expect(told).toEqual([
      ["c-1", key("1")],
      ["c-1", key("1")],
      ["c-2", key("2")],
    ]);
    expect(await keys.remove("c-1")).toBe(true);
    wrapping.close();
  });
});
