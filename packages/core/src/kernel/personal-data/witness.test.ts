import { describe, expect, it } from "vitest";
import { createFixedClock } from "../../contracts/clock.ts";
import { createKeptPersonalKeyStore } from "../../memory/personal-key-store.ts";
import type { PersonalKey } from "./crypto.ts";
import { witnessedWrapping } from "./witness.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

describe("a witnessed key wrapping", () => {
  it("tells of every key it hands out to seal or open with, and of none a person does not hold", async () => {
    const told: [string, PersonalKey][] = [];
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
    expect(await keys.held("c-1")).toBeNull();
    const created = await keys.create("c-1");
    const held = await keys.held("c-1");
    const stored = await keys.get("c-1");
    if (stored === null) throw new Error("no key stored");
    const opened = await keys.open("c-1", stored);
    expect([held?.fingerprint, opened.fingerprint]).toEqual([
      created.fingerprint,
      created.fingerprint,
    ]);
    expect(told.map(([person, key]) => [person, key.fingerprint])).toEqual([
      ["c-1", created.fingerprint],
      ["c-1", created.fingerprint],
      ["c-1", created.fingerprint],
    ]);
    expect(told[0]?.[1]).toBe(created);
    expect(await keys.remove("c-1")).toBe(true);
    wrapping.close();
  });
});
