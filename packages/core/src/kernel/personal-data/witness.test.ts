import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONAL_CATEGORY as D } from "../../adapter/storage/personal-key-store.ts";
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
    const keys = wrapping.over(
      createKeptPersonalKeyStore({ restricted: () => false, lastActiveAt: () => null }).store,
    );
    expect(await keys.held("c-1", D)).toBeNull();
    expect(await keys.opened("c-1", "f-none")).toBeNull();
    const created = await keys.create("c-1", D);
    const held = await keys.held("c-1", D);
    const stored = await keys.get("c-1", D);
    if (stored === null) throw new Error("no key stored");
    const opened = await keys.open("c-1", stored);
    const found = await keys.opened("c-1", created.fingerprint);
    const all = await keys.heldAll("c-1");
    expect([held, opened, found, all[0]?.key].map((key) => key?.fingerprint)).toEqual([
      created.fingerprint,
      created.fingerprint,
      created.fingerprint,
      created.fingerprint,
    ]);
    expect(told.map(([person, key]) => [person, key.fingerprint])).toEqual(
      Array.from({ length: 5 }, () => ["c-1", created.fingerprint]),
    );
    expect(told[0]?.[1]).toBe(created);
    expect(await keys.remove("c-1", created.fingerprint)).toBe(true);
    wrapping.close();
  });
});
