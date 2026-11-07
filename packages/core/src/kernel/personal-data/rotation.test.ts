import { describe, expect, it } from "vitest";
import type { PersonalKeyStore } from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { generatePersonalKey } from "./crypto.ts";
import type { KeyWrapper } from "./key-wrapper.ts";
import {
  createKeyRotation,
  ROTATION_BATCH,
  ROTATION_CHECK_INTERVAL_MS,
  ROTATION_MAX_RETRY_MS,
  ROTATION_RETRY_MS,
} from "./rotation.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

const fakeWrapper = (kid: string, previous?: readonly string[]): KeyWrapper => {
  const flip = (bytes: Uint8Array, under: string) => bytes.map((byte) => byte ^ under.length);
  return {
    kid,
    ...(previous === undefined ? {} : { previous }),
    wrap: async (key) => flip(key, kid),
    unwrap: async ({ kid: under, wrapped }) => flip(wrapped, under),
  };
};

interface Logged {
  readonly level: string;
  readonly message: string;
  readonly context?: Record<string, unknown> | undefined;
}

const recordingLogger = (): Logger & { readonly logged: Logged[] } => {
  const logged: Logged[] = [];
  const at =
    (level: string) =>
    (message: string, context?: Record<string, unknown>): void => {
      logged.push({ level, message, context });
    };
  return {
    logged,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
};

const setUp = async (wrapper: KeyWrapper = fakeWrapper("new", ["old"])) => {
  const store = (await memory().createStorage()).personalKeys;
  const clock = createFixedClock(new Date("2026-01-01T00:00:00Z"));
  const logger = recordingLogger();
  const wrapping = createPersonalKeyWrapping({ wrapper });
  const rotation = createKeyRotation({
    keys: store,
    wrapper,
    wrapping,
    clock,
    logger,
  });
  return { store, clock, logger, wrapping, rotation };
};

const addUnder = async (store: PersonalKeyStore, kid: string | null, person: string) => {
  const key = await generatePersonalKey();
  const wrapper = kid === null ? null : fakeWrapper(kid);
  await createPersonalKeyWrapping({ wrapper }).over(store).add(person, key);
  return key;
};

const kidsOf = async (store: PersonalKeyStore, persons: readonly string[]) =>
  Promise.all(persons.map(async (person) => (await store.get(person))?.kid));

describe("createKeyRotation", () => {
  it("rewraps under the current key what a previous key wrapped and what was kept unwrapped", async () => {
    const { store, clock, wrapping, rotation } = await setUp();
    const old = await addUnder(store, "old", "c-1");
    const plain = await addUnder(store, null, "c-2");
    const current = await addUnder(store, "new", "c-3");
    const other = await addUnder(store, "unknown", "c-4");
    expect(await rotation.sweep(clock.now())).toBe(2);
    expect(await kidsOf(store, ["c-1", "c-2", "c-3", "c-4"])).toEqual([
      "new",
      "new",
      "new",
      "unknown",
    ]);
    const keys = wrapping.over(store);
    expect(await keys.get("c-1")).toEqual(old);
    expect(await keys.get("c-2")).toEqual(plain);
    expect(await keys.get("c-3")).toEqual(current);
    expect((await store.get("c-4"))?.fingerprint).toBe(other.fingerprint);
  });

  it("rewraps at most ROTATION_BATCH keys a pass", async () => {
    const { store, clock, rotation } = await setUp();
    for (let index = 0; index <= ROTATION_BATCH; index += 1) {
      await addUnder(store, "old", `c-${String(index).padStart(3, "0")}`);
    }
    expect(await rotation.sweep(clock.now())).toBe(ROTATION_BATCH);
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await store.listWrappedUnder({ kids: ["old"], limit: 100 })).toEqual([]);
  });

  it("logs once, when none is left, that the previous keys can go, and again only after rewrapping more", async () => {
    const { store, clock, logger, rotation } = await setUp();
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(logger.logged).toEqual([]);
    expect(await rotation.sweep(clock.now())).toBe(0);
    const removable = {
      level: "info",
      message: "no personal key is wrapped under a previous key any more; remove them",
      context: { kid: "new", previous: ["old"] },
    };
    expect(logger.logged).toEqual([removable]);
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toEqual([removable]);
    await addUnder(store, "old", "c-2");
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await rotation.sweep(clock.now())).toBe(1);
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toEqual([removable, removable]);
  });

  it("without previous keys, logs only once it wrapped keys kept unwrapped", async () => {
    const quiet = await setUp(fakeWrapper("new"));
    expect(await quiet.rotation.sweep(quiet.clock.now())).toBe(0);
    expect(quiet.logger.logged).toEqual([]);
    const { store, clock, logger, rotation } = await setUp(fakeWrapper("new"));
    await addUnder(store, null, "c-1");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toEqual([
      { level: "info", message: "every personal key is wrapped", context: { kid: "new" } },
    ]);
  });

  it("rests ROTATION_CHECK_INTERVAL_MS after finding nothing, then finds a key an older instance wrote", async () => {
    const { store, clock, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    await addUnder(store, "old", "c-1");
    expect(await rotation.nextDueAt()).toEqual(
      new Date(clock.now().getTime() + ROTATION_CHECK_INTERVAL_MS),
    );
    clock.advance(ROTATION_CHECK_INTERVAL_MS - 1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await rotation.sweep(clock.now())).toBe(1);
  });

  it("leaves a key forgotten while it was being rewrapped forgotten", async () => {
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, rotation } = await setUp({
      ...wrapper,
      wrap: async (key) => {
        await store.remove("c-1");
        return wrapper.wrap(key);
      },
    });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await store.get("c-1")).toBeNull();
  });

  it("holds a key that failed to rewrap, longer after each failure, while the others go on", async () => {
    let failing = true;
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, logger, rotation } = await setUp({
      ...wrapper,
      unwrap: async (args) => {
        if (
          failing &&
          args.wrapped.length > 0 &&
          (await store.get("c-1"))?.key === toText(args.wrapped)
        ) {
          throw new Error("unwrap failed");
        }
        return wrapper.unwrap(args);
      },
    });
    await addUnder(store, "old", "c-1");
    await addUnder(store, "old", "c-2");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(logger.logged).toEqual([
      {
        level: "error",
        message: "personal key could not be rewrapped",
        context: expect.objectContaining({ personId: "c-1", kid: "old", message: "unwrap failed" }),
      },
    ]);
    const start = clock.now().getTime();
    expect(await rotation.nextDueAt()).toEqual(new Date(start + ROTATION_RETRY_MS));
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(ROTATION_RETRY_MS);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await rotation.nextDueAt()).toEqual(
      new Date(clock.now().getTime() + 2 * ROTATION_RETRY_MS),
    );
    for (let failures = 2; failures < 12; failures += 1) {
      clock.advance(ROTATION_MAX_RETRY_MS);
      await rotation.sweep(clock.now());
    }
    expect(await rotation.nextDueAt()).toEqual(
      new Date(clock.now().getTime() + ROTATION_MAX_RETRY_MS),
    );
    failing = false;
    clock.advance(ROTATION_MAX_RETRY_MS);
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.nextDueAt()).toBeNull();
  });

  it("holds the rotation ROTATION_RETRY_MS when the keys cannot be listed", async () => {
    const { store, clock, logger, wrapping } = await setUp();
    let broken = true;
    const keys: PersonalKeyStore = {
      ...store,
      listWrappedUnder: async (args) => {
        if (broken) throw new Error("database down");
        return store.listWrappedUnder(args);
      },
    };
    const rotation = createKeyRotation({
      keys,
      wrapper: fakeWrapper("new", ["old"]),
      wrapping,
      clock,
      logger,
    });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toEqual([
      {
        level: "error",
        message: "personal keys to rewrap could not be listed",
        context: expect.objectContaining({ message: "database down" }),
      },
    ]);
    broken = false;
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + ROTATION_RETRY_MS));
    clock.advance(ROTATION_RETRY_MS - 1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await rotation.sweep(clock.now())).toBe(1);
  });

  it("logs that the previous keys can go on its first pass when it finds none to rewrap", async () => {
    const { clock, logger, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged.map(({ message }) => message)).toEqual([
      "no personal key is wrapped under a previous key any more; remove them",
    ]);
  });

  it("fills a pass with ROTATION_BATCH keys besides those held", async () => {
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, rotation } = await setUp({
      ...wrapper,
      wrap: async (key) => {
        if ((await store.get("a-held"))?.kid === "old" && failing) throw new Error("wrap failed");
        return wrapper.wrap(key);
      },
    });
    let failing = true;
    await addUnder(store, "old", "a-held");
    expect(await rotation.sweep(clock.now())).toBe(0);
    failing = false;
    for (let index = 0; index <= ROTATION_BATCH; index += 1) {
      await addUnder(store, "old", `c-${String(index).padStart(3, "0")}`);
    }
    expect(await rotation.sweep(clock.now())).toBe(ROTATION_BATCH);
  });

  it("never takes the current key for a previous one, even when the wrapper names it so", async () => {
    const { store, clock, logger, rotation } = await setUp(fakeWrapper("new", ["new"]));
    await addUnder(store, "new", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await rotation.nextDueAt()).toBeNull();
    expect(logger.logged).toEqual([]);
  });

  it("is due now while a key waits, and never otherwise", async () => {
    const { store, clock, rotation } = await setUp();
    expect(await rotation.nextDueAt()).toBeNull();
    await addUnder(store, "new", "c-1");
    expect(await rotation.nextDueAt()).toBeNull();
    await addUnder(store, "old", "c-2");
    expect(await rotation.nextDueAt()).toEqual(clock.now());
  });
});

const toText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
