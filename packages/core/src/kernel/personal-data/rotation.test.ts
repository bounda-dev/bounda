import { describe, expect, it } from "vitest";
import type { CheckpointStore } from "../../adapter/storage/checkpoint-store.ts";
import {
  DEFAULT_PERSONAL_CATEGORY,
  type PersonalKeyStore,
  type StoredPersonalKey,
} from "../../adapter/storage/personal-key-store.ts";
import { createFixedClock } from "../../contracts/clock.ts";
import type { Logger } from "../../contracts/logger.ts";
import { memory } from "../../memory/index.ts";
import { LEASE_MS } from "../shared/lease.ts";
import { removeKeys, testMaster, testTenantKeys } from "../test-support.ts";
import {
  fingerprintOf,
  generateWrappableKey,
  TENANT_KEY_ALGORITHM,
  TENANT_KEY_USAGES,
  toBase64,
  withRawKey,
} from "./crypto.ts";
import { HOLD_MAX_MS, HOLD_MS } from "./hold.ts";
import {
  createKeyRotation,
  ROTATED_PREFIX,
  ROTATION_BATCH,
  ROTATION_CHECK_INTERVAL_MS,
  ROTATION_LEASE_PREFIX,
  ROTATION_MARK_EXPIRY_MS,
} from "./rotation.ts";
import type { TenantKeys } from "./tenant-keys.ts";
import { createPersonalKeyWrapping } from "./wrapped-keys.ts";

// One version per kid, for the whole file: two fakes that name a kid share its key.
const versions = new Map<string, Promise<CryptoKey>>();
const versionOf = (kid: string): Promise<CryptoKey> => {
  const known = versions.get(kid);
  if (known !== undefined) return known;
  const created = crypto.subtle.generateKey({ name: TENANT_KEY_ALGORITHM, length: 256 }, false, [
    ...TENANT_KEY_USAGES,
  ]);
  versions.set(kid, created);
  return created;
};

// A tenant whose key is `kid`, its older versions `previous`.
const fakeWrapper = (kid: string, previous: readonly string[] = []): TenantKeys => {
  const known = [kid, ...previous];
  return {
    ...testTenantKeys,
    current: async () => ({ kid, key: await versionOf(kid) }),
    keyOf: async (asked) => (known.includes(asked) ? versionOf(asked) : null),
    knows: (asked) => known.includes(asked),
    kids: async () => ({ kid, previous, since: new Date(0).toISOString() }),
  };
};

const wrappingOver = (tenantKeys: TenantKeys) =>
  createPersonalKeyWrapping({ tenantKeys, master: testMaster, clock });

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

const clock = createFixedClock(new Date("2026-01-01T00:00:00Z"));

interface RotationOverArgs {
  readonly keys: PersonalKeyStore;
  readonly checkpoints: CheckpointStore;
  readonly wrapper: TenantKeys;
  readonly logger?: Logger;
}

// Another instance, or this one after a restart: a rotation and its unwrapped keys of its own.
const rotationOver = ({
  keys,
  checkpoints,
  wrapper,
  logger = recordingLogger(),
}: RotationOverArgs) =>
  createKeyRotation({
    keys,
    checkpoints,
    tenantKeys: wrapper,
    master: testMaster,
    wrapping: wrappingOver(wrapper),
    clock,
    logger,
  });

const setUp = async (
  wrapper: TenantKeys = fakeWrapper("new", ["old"]),
  failOn: (stored: StoredPersonalKey) => Promise<boolean> = async () => false,
) => {
  const storage = await memory().createStorage();
  const store = storage.personalKeys;
  const checkpoints = storage.checkpointStore;
  clock.set(new Date(clock.now().getTime() + 1_000 * ROTATION_CHECK_INTERVAL_MS));
  const logger = recordingLogger();
  const wrapping = wrappingOver(wrapper);
  const rotation = createKeyRotation({
    keys: store,
    checkpoints,
    tenantKeys: wrapper,
    master: testMaster,
    wrapping: {
      kids: () => wrapping.kids(),
      wrapped: async (stored) => {
        if (await failOn(stored)) throw new Error("unwrap failed");
        return wrapping.wrapped(stored);
      },
    },
    clock,
    logger,
  });
  return { store, checkpoints, clock, logger, wrapping, rotation };
};

// Counts what reaches the key table.
const counted = (store: PersonalKeyStore) => {
  const reads = { count: 0 };
  const keys: PersonalKeyStore = {
    ...store,
    listWrappedUnder: (args) => {
      reads.count += 1;
      return store.listWrappedUnder(args);
    },
    nextHoldEnd: (args) => {
      reads.count += 1;
      return store.nextHoldEnd(args);
    },
  };
  return { keys, reads };
};

// Counts the reads of the marks.
const countedMarks = (checkpoints: CheckpointStore) => {
  const reads = { count: 0 };
  const counting: CheckpointStore = {
    ...checkpoints,
    get: (name) => {
      if (name.startsWith(ROTATED_PREFIX)) reads.count += 1;
      return checkpoints.get(name);
    },
  };
  return { checkpoints: counting, reads };
};

// The key as the store keeps it.
const addUnder = async (store: PersonalKeyStore, kid: string | null, person: string) => {
  if (kid === null) {
    // As a version of Bounda before key wrappers kept it: its raw bytes in base64.
    const key = await generateWrappableKey();
    await store.add(person, DEFAULT_PERSONAL_CATEGORY, {
      key: await withRawKey(key, async (raw) => toBase64(raw)),
      fingerprint: await fingerprintOf(key),
      kid: null,
    });
  } else {
    await wrappingOver(fakeWrapper(kid)).over(store).create(person, DEFAULT_PERSONAL_CATEGORY);
  }
  const stored = await store.get(person, DEFAULT_PERSONAL_CATEGORY);
  if (stored === null) throw new Error(`no key stored for ${person}`);
  return stored;
};

const kidsOf = async (store: PersonalKeyStore, persons: readonly string[]) =>
  Promise.all(
    persons.map(async (person) => (await store.get(person, DEFAULT_PERSONAL_CATEGORY))?.kid),
  );

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
    expect((await keys.held("c-1", DEFAULT_PERSONAL_CATEGORY))?.fingerprint).toBe(old.fingerprint);
    expect((await keys.held("c-2", DEFAULT_PERSONAL_CATEGORY))?.fingerprint).toBe(
      plain.fingerprint,
    );
    expect((await keys.held("c-3", DEFAULT_PERSONAL_CATEGORY))?.fingerprint).toBe(
      current.fingerprint,
    );
    expect((await store.get("c-3", DEFAULT_PERSONAL_CATEGORY))?.key).toBe(current.key);
    expect((await store.get("c-4", DEFAULT_PERSONAL_CATEGORY))?.fingerprint).toBe(
      other.fingerprint,
    );
  });

  it("rewraps the key of the blind indexes with the persons' keys, and completes only once it did", async () => {
    const storage = await memory().createStorage();
    const wrapper = fakeWrapper("new", ["old"]);
    const logger = recordingLogger();
    const generated = await wrappingOver(fakeWrapper("old")).generate();
    await storage.indexKeys.add(generated.stored, clock.now());
    let failing = true;
    const rotation = createKeyRotation({
      keys: storage.personalKeys,
      indexKeys: {
        ...storage.indexKeys,
        rewrap: (from, to) =>
          failing ? Promise.reject(new Error("index down")) : storage.indexKeys.rewrap(from, to),
      },
      checkpoints: storage.checkpointStore,
      tenantKeys: wrapper,
      master: testMaster,
      wrapping: wrappingOver(wrapper),
      clock,
      logger,
    });
    clock.set(new Date(clock.now().getTime() + 1_000 * ROTATION_CHECK_INTERVAL_MS));
    expect(await rotation.nextDueAt()).toEqual(clock.now());
    expect(await rotation.status()).toMatchObject({ pending: 1, completeAt: null });
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toContainEqual({
      level: "error",
      message: "the database's key could not be rewrapped",
      context: expect.objectContaining({ kid: "old" }),
    });
    expect((await storage.indexKeys.get())?.kid).toBe("old");
    expect((await rotation.status()).completeAt).toBeNull();
    failing = false;
    clock.set(new Date(clock.now().getTime() + 1_000 * ROTATION_CHECK_INTERVAL_MS));
    await rotation.sweep(clock.now());
    expect((await storage.indexKeys.get())?.kid).toBe("new");
    expect((await storage.indexKeys.get())?.fingerprint).toBe(generated.stored.fingerprint);
    expect(await rotation.status()).toMatchObject({ pending: 0 });
    await rotation.sweep(clock.now());
    expect((await rotation.status()).completeAt).not.toBeNull();
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
      message: "no key is wrapped under an older version of the tenant's key any more; retire them",
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
      {
        level: "info",
        message: "every key is wrapped under the tenant's key",
        context: { kid: "new" },
      },
    ]);
    const plain = fakeWrapper("new");
    const gone = await setUp({
      ...plain,
      current: async () => {
        await removeKeys(gone.store, "c-1");
        return plain.current();
      },
    });
    await addUnder(gone.store, null, "c-1");
    expect(await gone.rotation.sweep(gone.clock.now())).toBe(0);
    expect(await gone.rotation.sweep(gone.clock.now())).toBe(0);
    expect(gone.logger.logged).toEqual([]);
  });

  it("rests ROTATION_CHECK_INTERVAL_MS after finding nothing, then finds a key an older instance wrote", async () => {
    const { store, clock, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    await addUnder(store, "old", "c-1");
    expect(await rotation.nextDueAt()).toBeNull();
    clock.advance(ROTATION_CHECK_INTERVAL_MS - 1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await rotation.sweep(clock.now())).toBe(1);
  });

  it("leaves a key forgotten while it was being rewrapped forgotten", async () => {
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, rotation } = await setUp({
      ...wrapper,
      current: async () => {
        await removeKeys(store, "c-1");
        return wrapper.current();
      },
    });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await store.get("c-1", DEFAULT_PERSONAL_CATEGORY)).toBeNull();
  });

  it("holds a key that failed to rewrap, longer after each failure, while the others go on", async () => {
    let failing = true;
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, logger, rotation } = await setUp(
      wrapper,
      async (stored) =>
        failing && (await store.get("c-1", DEFAULT_PERSONAL_CATEGORY))?.key === stored.key,
    );
    await addUnder(store, "old", "c-1");
    await addUnder(store, "old", "c-2");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(logger.logged).toEqual([
      {
        level: "error",
        message: "personal key could not be rewrapped",
        context: expect.objectContaining({
          personId: "c-1",
          kid: "old",
          error: expect.objectContaining({ message: "unwrap failed" }),
        }),
      },
    ]);
    const start = clock.now().getTime();
    expect(await rotation.nextDueAt()).toEqual(new Date(start + HOLD_MS));
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(HOLD_MS);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    for (let failures = 2; failures < 12; failures += 1) {
      clock.advance(HOLD_MAX_MS);
      await rotation.sweep(clock.now());
    }
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MAX_MS));
    failing = false;
    clock.advance(HOLD_MAX_MS);
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.nextDueAt()).toBeNull();
  });

  it("holds the rotation HOLD_MS when the keys cannot be listed", async () => {
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
      checkpoints: (await memory().createStorage()).checkpointStore,
      tenantKeys: fakeWrapper("new", ["old"]),
      master: testMaster,
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
        context: expect.objectContaining({
          error: expect.objectContaining({ message: "database down" }),
        }),
      },
    ]);
    broken = false;
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    clock.advance(HOLD_MS - 1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    clock.advance(1);
    expect(await rotation.sweep(clock.now())).toBe(1);
  });

  it("logs that the previous keys can go on its first pass when it finds none to rewrap", async () => {
    const { clock, logger, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged.map(({ message }) => message)).toEqual([
      "no key is wrapped under an older version of the tenant's key any more; retire them",
    ]);
  });

  it("fills a pass with ROTATION_BATCH keys besides those held", async () => {
    const wrapper = fakeWrapper("new", ["old"]);
    const { store, clock, rotation } = await setUp({
      ...wrapper,
      current: async () => {
        if ((await store.get("a-held", DEFAULT_PERSONAL_CATEGORY))?.kid === "old" && failing)
          throw new Error("wrap failed");
        return wrapper.current();
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

  it("marks the rotation complete: nextDueAt never reads the key table again, nor a pass but once an interval", async () => {
    const { store, checkpoints: stored, clock } = await setUp();
    const { keys, reads } = counted(store);
    const { checkpoints, reads: markReads } = countedMarks(stored);
    const wrapper = fakeWrapper("new", ["old"]);
    const rotation = rotationOver({ keys, checkpoints, wrapper });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    const markedAt = clock.now().getTime();
    // Within the interval this instance reads not even the mark.
    const marked = markReads.count;
    for (let pass = 0; pass < 3; pass += 1) {
      expect(await rotation.sweep(clock.now())).toBe(0);
      expect(await rotation.nextDueAt()).toBeNull();
    }
    clock.advance(ROTATION_CHECK_INTERVAL_MS - 1);
    expect(await rotation.nextDueAt()).toBeNull();
    expect(markReads.count).toBe(marked);
    clock.advance(1);
    const marks = (await checkpoints.list()).filter(({ subscriber }) =>
      subscriber.startsWith(ROTATED_PREFIX),
    );
    expect(marks).toEqual([{ subscriber: expect.any(String), position: markedAt }]);
    const before = reads.count;
    for (let pass = 0; pass < 10; pass += 1) expect(await rotation.nextDueAt()).toBeNull();
    const restarted = rotationOver({ keys, checkpoints, wrapper });
    expect(await restarted.nextDueAt()).toBeNull();
    expect(reads.count).toBe(before);
    // A host that asks before every pass still gets its once-an-interval check.
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(reads.count).toBeGreaterThan(before);
    const checked = reads.count;
    for (let pass = 0; pass < 5; pass += 1) {
      expect(await rotation.nextDueAt()).toBeNull();
      expect(await rotation.sweep(clock.now())).toBe(0);
      clock.advance(ROTATION_CHECK_INTERVAL_MS / 10);
    }
    expect(reads.count).toBe(checked);
  });

  it("answers a key due without reading the table again until an interval passes, and never before a rest ends", async () => {
    const { store, checkpoints, clock } = await setUp();
    const { keys, reads } = counted(store);
    const failing = fakeWrapper("new", ["old"]);
    const rotation = rotationOver({
      keys,
      checkpoints,
      wrapper: {
        ...failing,
        current: async () => {
          throw new Error("wrap failed");
        },
      },
    });
    await addUnder(store, "old", "a-held");
    expect(await rotation.sweep(clock.now())).toBe(0);
    const heldAt = clock.now().getTime();
    expect(await rotation.sweep(clock.now())).toBe(0);
    await addUnder(store, "old", "c-1");
    expect(await rotation.nextDueAt()).toEqual(new Date(heldAt + HOLD_MS));
    const read = reads.count;
    for (let ask = 0; ask < 5; ask += 1) {
      expect(await rotation.nextDueAt()).toEqual(new Date(heldAt + HOLD_MS));
    }
    clock.advance(ROTATION_CHECK_INTERVAL_MS - 1);
    expect(await rotation.nextDueAt()).toEqual(new Date(heldAt + HOLD_MS));
    expect(reads.count).toBe(read);
    clock.advance(1);
    expect(await rotation.nextDueAt()).toEqual(clock.now());
    expect(reads.count).toBeGreaterThan(read);
  });

  it("checks a mark once an interval across instances, and drops it for a key found again", async () => {
    const { store, checkpoints, clock } = await setUp();
    const { keys, reads } = counted(store);
    const wrapper = fakeWrapper("new", ["old"]);
    const first = rotationOver({ keys, checkpoints, wrapper });
    const counting = countedMarks(checkpoints);
    const second = rotationOver({ keys, checkpoints: counting.checkpoints, wrapper });
    expect(await first.sweep(clock.now())).toBe(0);
    const afterMark = reads.count;
    expect(await second.sweep(clock.now())).toBe(0);
    expect(await second.sweep(clock.now())).toBe(0);
    expect(reads.count).toBe(afterMark);
    expect(counting.reads.count).toBe(1);
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await second.sweep(clock.now())).toBe(0);
    const afterCheck = reads.count;
    expect(afterCheck).toBeGreaterThan(afterMark);
    expect(await first.sweep(clock.now())).toBe(0);
    expect(reads.count).toBe(afterCheck);
    await addUnder(store, "old", "c-1");
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await first.sweep(clock.now())).toBe(1);
    expect(
      (await checkpoints.list()).filter(({ subscriber }) => subscriber.startsWith(ROTATED_PREFIX)),
    ).toEqual([]);
    expect(await second.nextDueAt()).toBeNull();
    const fresh = rotationOver({ keys, checkpoints, wrapper });
    await addUnder(store, "old", "c-2");
    expect(await fresh.nextDueAt()).toEqual(clock.now());
  });

  it("reads the key table again once another set of keys is configured, and removes marks no instance renews", async () => {
    const { store, checkpoints, clock, rotation } = await setUp();
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    const rotated = async () =>
      (await checkpoints.list())
        .map(({ subscriber }) => subscriber)
        .filter((subscriber) => subscriber.startsWith(ROTATED_PREFIX));
    const [first] = await rotated();
    const logger = recordingLogger();
    const next = rotationOver({
      keys: store,
      checkpoints,
      wrapper: fakeWrapper("newer", ["new", "old"]),
      logger,
    });
    expect(await next.nextDueAt()).toEqual(clock.now());
    expect(await next.sweep(clock.now())).toBe(1);
    expect(await kidsOf(store, ["c-1"])).toEqual(["newer"]);
    expect(await next.sweep(clock.now())).toBe(0);
    // The first set's mark is fresh: an instance on that set may still run, so it stays.
    expect(await rotated()).toHaveLength(2);
    expect(logger.logged.map(({ message }) => message)).toEqual([
      "no key is wrapped under an older version of the tenant's key any more; retire them",
    ]);
    await checkpoints.set("some-subscriber", 1);
    clock.advance(ROTATION_MARK_EXPIRY_MS);
    expect(await next.sweep(clock.now())).toBe(0);
    expect(await checkpoints.get("some-subscriber")).toBe(1);
    const marks = await rotated();
    expect(marks).toHaveLength(1);
    expect(marks).not.toContain(first);
    expect(logger.logged).toHaveLength(1);
    const { keys, reads } = counted(store);
    const same = rotationOver({
      keys,
      checkpoints,
      wrapper: fakeWrapper("newer", ["old", "new", "old"]),
    });
    expect(await same.nextDueAt()).toBeNull();
    expect(reads.count).toBe(0);
    const more = rotationOver({
      keys,
      checkpoints,
      wrapper: fakeWrapper("newer", ["new", "old", "oldest"]),
    });
    expect(await more.nextDueAt()).toBeNull();
    expect(reads.count).toBeGreaterThan(0);
  });

  it("holds a failed key on its row, so another instance skips it until the hold ends and a restart backs off from it", async () => {
    const { store, checkpoints, clock } = await setUp();
    const wrapper = fakeWrapper("new", ["old"]);
    const failing: TenantKeys = {
      ...wrapper,
      keyOf: async () => {
        throw new Error("unwrap failed");
      },
    };
    await addUnder(store, "old", "c-1");
    const failedAt = clock.now().getTime();
    const first = rotationOver({ keys: store, checkpoints, wrapper: failing });
    expect(await first.sweep(clock.now())).toBe(0);
    // Stopped, as an instance gives its lease back when it stops.
    await first.release();
    const [row] = await store.listWrappedUnder({ kids: ["old"], limit: 1 });
    expect(row?.hold).toEqual({ until: new Date(failedAt + HOLD_MS).toISOString(), attempts: 1 });
    const healthy = rotationOver({ keys: store, checkpoints, wrapper });
    expect(await healthy.sweep(clock.now())).toBe(0);
    expect(await healthy.nextDueAt()).toEqual(new Date(failedAt + HOLD_MS));
    clock.advance(HOLD_MS);
    const restarted = rotationOver({ keys: store, checkpoints, wrapper: failing });
    expect(await restarted.sweep(clock.now())).toBe(0);
    expect(await restarted.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    await restarted.release();
    clock.advance(2 * HOLD_MS);
    expect(await healthy.sweep(clock.now())).toBe(1);
    expect(await store.listWrappedUnder({ kids: ["new"], limit: 1 })).toEqual([
      expect.objectContaining({ person: "c-1", hold: null }),
    ]);
  });

  it("drops a stale mark for a key another instance holds, and names its hold's end", async () => {
    const { store, checkpoints, clock, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    const key = await addUnder(store, "old", "c-1");
    const [row] = await store.listWrappedUnder({ kids: ["old"], limit: 1 });
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    const end = new Date(clock.now().getTime() + HOLD_MS);
    await store.hold("c-1", row?.key ?? key, {
      until: end.toISOString(),
      attempts: 1,
    });
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(
      (await checkpoints.list()).filter(({ subscriber }) => subscriber.startsWith(ROTATED_PREFIX)),
    ).toEqual([]);
    expect(
      await rotationOver({
        keys: store,
        checkpoints,
        wrapper: fakeWrapper("new", ["old"]),
      }).nextDueAt(),
    ).toEqual(end);
  });

  it("holds the whole rotation when a hold cannot be written", async () => {
    const { store, checkpoints, clock } = await setUp();
    const logger = recordingLogger();
    const wrapper = fakeWrapper("new", ["old"]);
    const rotation = rotationOver({
      keys: {
        ...store,
        hold: async () => {
          throw new Error("read-only");
        },
      },
      checkpoints,
      wrapper: {
        ...wrapper,
        keyOf: async () => {
          throw new Error("unwrap failed");
        },
      },
      logger,
    });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged.map(({ message }) => message)).toEqual([
      "personal key could not be rewrapped",
      "personal key could not be held",
    ]);
    expect(logger.logged[1]?.context).toEqual(
      expect.objectContaining({
        personId: "c-1",
        kid: "old",
        error: expect.objectContaining({ message: "read-only" }),
      }),
    );
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
    clock.advance(HOLD_MS - 1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toHaveLength(2);
  });

  it("waits longer while holds cannot be written, and as long as the first again after a pass that kept them", async () => {
    const { store, checkpoints, clock } = await setUp();
    let writable = false;
    const wrapper = fakeWrapper("new", ["old"]);
    const rotation = rotationOver({
      keys: {
        ...store,
        hold: async (person, from, hold) => {
          if (!writable) throw new Error("read-only");
          return store.hold(person, from, hold);
        },
      },
      checkpoints,
      wrapper: {
        ...wrapper,
        keyOf: async () => {
          throw new Error("unwrap failed");
        },
      },
    });
    await addUnder(store, "old", "c-1");
    await rotation.sweep(clock.now());
    clock.advance(HOLD_MS);
    await rotation.sweep(clock.now());
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + 2 * HOLD_MS));
    clock.advance(2 * HOLD_MS);
    writable = true;
    await rotation.sweep(clock.now());
    writable = false;
    await addUnder(store, "old", "c-2");
    clock.advance(HOLD_MS);
    await rotation.sweep(clock.now());
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS));
  });

  it("is due now while a key waits, and never otherwise, reading the store once an interval at most", async () => {
    const { store, clock, rotation } = await setUp();
    expect(await rotation.nextDueAt()).toBeNull();
    await addUnder(store, "new", "c-1");
    await addUnder(store, "old", "c-2");
    expect(await rotation.nextDueAt()).toBeNull();
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    expect(await rotation.nextDueAt()).toEqual(clock.now());
    expect(await rotation.nextDueAt()).toEqual(clock.now());
  });

  it("checks a mark set ahead of its own clock instead of trusting it longer", async () => {
    const { store, checkpoints, clock, rotation } = await setUp();
    expect(await rotation.sweep(clock.now())).toBe(0);
    const [mark] = (await checkpoints.list()).filter(({ subscriber }) =>
      subscriber.startsWith(ROTATED_PREFIX),
    );
    await checkpoints.set(mark?.subscriber ?? "", clock.now().getTime() + 20 * 60_000);
    await addUnder(store, "old", "c-1");
    const behind = rotationOver({ keys: store, checkpoints, wrapper: fakeWrapper("new", ["old"]) });
    expect(await behind.sweep(clock.now())).toBe(1);
  });

  it("rests while every key left is held, until the first hold ends", async () => {
    const { store, checkpoints, clock } = await setUp();
    const { keys, reads } = counted(store);
    const failing = fakeWrapper("new", ["old"]);
    const rotation = rotationOver({
      keys,
      checkpoints,
      wrapper: {
        ...failing,
        keyOf: async () => {
          throw new Error("unwrap failed");
        },
      },
    });
    await addUnder(store, "old", "c-1");
    expect(await rotation.sweep(clock.now())).toBe(0);
    const held = reads.count;
    for (let pass = 0; pass < 5; pass += 1) {
      clock.advance(HOLD_MS / 10);
      expect(await rotation.sweep(clock.now())).toBe(0);
    }
    expect(reads.count).toBe(held + 2);
    expect(await rotation.nextDueAt()).toEqual(new Date(clock.now().getTime() + HOLD_MS / 2));
  });
});

describe("the key rotation across instances", () => {
  const wrapper = () => fakeWrapper("new", ["old"]);

  // Counts the rewraps each key had, by person, whichever instance wrote them.
  const countingRewraps = (
    store: PersonalKeyStore,
    counts: Map<string, number>,
    afterEach: () => Promise<void> = async () => undefined,
  ): PersonalKeyStore => ({
    ...store,
    rewrap: async (person, from, to) => {
      counts.set(person, (counts.get(person) ?? 0) + 1);
      const rewrapped = await store.rewrap(person, from, to);
      await afterEach();
      return rewrapped;
    },
  });

  it("rewraps each key once while two instances run it: the one holding the lease", async () => {
    const { store, checkpoints } = await setUp();
    const persons = ["c-1", "c-2", "c-3"];
    for (const person of persons) await addUnder(store, "old", person);
    const counts = new Map<string, number>();
    const keys = countingRewraps(store, counts);
    const one = rotationOver({ keys, checkpoints, wrapper: wrapper() });
    const other = rotationOver({ keys, checkpoints, wrapper: wrapper() });
    expect(await one.sweep(clock.now())).toBe(3);
    expect(await other.sweep(clock.now())).toBe(0);
    expect(await kidsOf(store, persons)).toEqual(["new", "new", "new"]);
    expect([...counts.values()]).toEqual([1, 1, 1]);
    const leases = (await checkpoints.list()).filter(({ subscriber }) =>
      subscriber.startsWith(ROTATION_LEASE_PREFIX),
    );
    expect(leases.map(({ position }) => position)).toEqual([clock.now().getTime() + LEASE_MS]);
  });

  it("leaves another instance's keys to it while it holds the lease, and names when it lapses", async () => {
    const { store, checkpoints } = await setUp();
    await addUnder(store, "old", "c-1");
    const one = rotationOver({ keys: store, checkpoints, wrapper: wrapper() });
    const leased = clock.now().getTime() + LEASE_MS;
    expect(await one.sweep(clock.now())).toBe(1);
    await addUnder(store, "old", "c-2");
    clock.advance(ROTATION_CHECK_INTERVAL_MS);
    const { keys, reads } = counted(store);
    const other = rotationOver({ keys, checkpoints, wrapper: wrapper() });
    expect(await other.sweep(clock.now())).toBe(0);
    expect(await other.sweep(clock.now())).toBe(0);
    expect(reads.count).toBe(1);
    expect(await kidsOf(store, ["c-2"])).toEqual(["old"]);
    expect(await other.nextDueAt()).toEqual(new Date(leased));
    await one.release();
    expect(await other.sweep(clock.now())).toBe(1);
  });

  it("hands the rest to another instance when its lease lapses mid-way, rewrapping no key twice", async () => {
    const { store, checkpoints } = await setUp();
    const persons = ["c-1", "c-2", "c-3", "c-4"];
    for (const person of persons) await addUnder(store, "old", person);
    const counts = new Map<string, number>();
    let handedOver = 0;
    const plain = countingRewraps(store, counts);
    const other = rotationOver({ keys: plain, checkpoints, wrapper: wrapper() });
    // After its second key the instance stalls past its lease, and the other runs a pass.
    const stalling = countingRewraps(store, counts, async () => {
      if (counts.size !== 2 || handedOver > 0) return;
      clock.advance(LEASE_MS);
      handedOver = await other.sweep(clock.now());
    });
    const one = rotationOver({ keys: stalling, checkpoints, wrapper: wrapper() });
    expect(await one.sweep(clock.now())).toBe(2);
    expect(handedOver).toBe(2);
    expect(await kidsOf(store, persons)).toEqual(["new", "new", "new", "new"]);
    expect([...counts.values()]).toEqual([1, 1, 1, 1]);
  });

  it("starts over at once after a restore taken mid-way, without the holds the copy brought back", async () => {
    const { store, checkpoints } = await setUp();
    await addUnder(store, "old", "c-1");
    const held = await addUnder(store, "old", "c-2");
    const later = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
    await store.hold("c-2", held, { until: later(HOLD_MAX_MS), attempts: 7 });
    const rotation = rotationOver({ keys: store, checkpoints, wrapper: wrapper() });
    expect(await rotation.sweep(clock.now())).toBe(1);
    // The rotation goes on to the end, then the copy taken at this point comes back: c-2 held
    // again under the old key, and no mark.
    await store.hold("c-2", held, { until: later(0), attempts: 7 });
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(await rotation.nextDueAt()).toBeNull();
    await store.remove("c-2", held.fingerprint);
    await store.add("c-2", "default", held);
    await store.hold("c-2", held, { until: later(HOLD_MAX_MS), attempts: 7 });
    for (const { subscriber } of await checkpoints.list()) await checkpoints.remove(subscriber);
    await rotation.restored(true);
    expect(await store.listWrappedUnder({ kids: ["old"], limit: 10 })).toEqual([
      { person: "c-2", category: "default", key: held, hold: null },
    ]);
    expect(await rotation.nextDueAt()).toEqual(clock.now());
    expect(await rotation.sweep(clock.now())).toBe(1);
    expect(await kidsOf(store, ["c-1", "c-2"])).toEqual(["new", "new"]);
  });

  it("rewraps again at once after a restore, though the store had paused it", async () => {
    const { store, checkpoints } = await setUp();
    await addUnder(store, "old", "c-1");
    let down = true;
    const rotation = rotationOver({
      keys: {
        ...store,
        listWrappedUnder: (args) =>
          down ? Promise.reject(new Error("down")) : store.listWrappedUnder(args),
      },
      checkpoints,
      wrapper: wrapper(),
    });
    expect(await rotation.sweep(clock.now())).toBe(0);
    down = false;
    expect(await rotation.sweep(clock.now())).toBe(0);
    await rotation.restored(false);
    expect(await rotation.sweep(clock.now())).toBe(1);
  });

  it("leaves the holds to the instance that found the restore first", async () => {
    const { store, checkpoints } = await setUp();
    const held = await addUnder(store, "old", "c-1");
    const hold = { until: new Date(clock.now().getTime() + HOLD_MS).toISOString(), attempts: 2 };
    await store.hold("c-1", held, hold);
    const rotation = rotationOver({ keys: store, checkpoints, wrapper: wrapper() });
    await rotation.restored(false);
    expect((await store.listWrappedUnder({ kids: ["old"], limit: 1 }))[0]?.hold).toEqual(hold);
  });

  it("logs holds it could not clear after a restore, and goes on", async () => {
    const { store, checkpoints } = await setUp();
    const logger = recordingLogger();
    const rotation = rotationOver({
      keys: { ...store, releaseHolds: () => Promise.reject(new Error("cannot write")) },
      checkpoints,
      wrapper: wrapper(),
      logger,
    });
    await rotation.restored(true);
    expect(logger.logged).toContainEqual({
      level: "error",
      message: "personal keys' holds could not be cleared",
      context: { error: expect.objectContaining({ message: "cannot write" }) },
    });
  });

  it("says how many keys are left to rewrap, and when a pass last found none", async () => {
    const { store, checkpoints } = await setUp();
    await addUnder(store, "old", "c-1");
    await addUnder(store, null, "c-2");
    const rotation = rotationOver({
      keys: store,
      checkpoints,
      wrapper: fakeWrapper("new", ["old", "new"]),
    });
    expect(await rotation.status()).toEqual({
      kid: "new",
      previous: ["old"],
      pending: 2,
      completeAt: null,
      reseal: null,
    });
    await rotation.sweep(clock.now());
    await rotation.sweep(clock.now());
    expect(await rotation.status()).toEqual({
      kid: "new",
      previous: ["old"],
      pending: 0,
      completeAt: clock.now().toISOString(),
      reseal: null,
    });
  });
});

describe("the tenant's key under the master key", () => {
  const master = { kid: "m-new", previous: ["m-old"] };

  // A tenant whose record is under the previous master key until rewrapped, as `rewrap` says.
  const underMaster = (rewrap: () => Promise<boolean>, under = true) => {
    const state = { under, calls: 0 };
    const tenantKeys: TenantKeys = {
      ...fakeWrapper("new"),
      underPreviousMaster: () => state.under,
      rewrapUnderMaster: async () => {
        state.calls += 1;
        state.under = !(await rewrap());
        return state.under ? 0 : 1;
      },
    };
    return { state, tenantKeys };
  };

  const rotationWith = async (tenantKeys: TenantKeys, of = master) => {
    const storage = await memory().createStorage();
    const logger = recordingLogger();
    clock.set(new Date(clock.now().getTime() + 1_000 * ROTATION_CHECK_INTERVAL_MS));
    const rotation = createKeyRotation({
      keys: storage.personalKeys,
      checkpoints: storage.checkpointStore,
      tenantKeys,
      master: of,
      wrapping: wrappingOver(tenantKeys),
      clock,
      logger,
    });
    return { rotation, logger };
  };

  const removeThem = {
    level: "info",
    message:
      "this tenant's key is wrapped under the master key in force; remove the previous ones once bounda tenant-key rewrap-master, or the Worker's schedule, finds no tenant left under them",
    context: { kid: "m-new", previous: ["m-old"] },
  };

  it("is due at once while a version is under a previous master key, rewraps it, and logs once that the previous can go", async () => {
    const { state, tenantKeys } = underMaster(async () => true);
    const { rotation, logger } = await rotationWith(tenantKeys);
    expect(await rotation.nextDueAt()).toEqual(clock.now());
    await rotation.sweep(clock.now());
    expect(state.calls).toBe(1);
    expect(logger.logged.filter(({ message }) => message === removeThem.message)).toEqual([
      removeThem,
    ]);
    clock.set(new Date(clock.now().getTime() + 2 * ROTATION_CHECK_INTERVAL_MS));
    await rotation.sweep(clock.now());
    expect(state.calls).toBe(1);
    expect(logger.logged.filter(({ message }) => message === removeThem.message)).toHaveLength(1);
    expect((await rotation.status()).completeAt).not.toBeNull();
  });

  it("logs as much for a record another instance rewrapped, and nothing without a previous master key", async () => {
    const elsewhere = underMaster(async () => true, false);
    const { rotation, logger } = await rotationWith(elsewhere.tenantKeys);
    await rotation.sweep(clock.now());
    expect(elsewhere.state.calls).toBe(0);
    expect(logger.logged).toContainEqual(removeThem);

    const alone = underMaster(async () => true, false);
    const single = await rotationWith(alone.tenantKeys, { kid: "m-new", previous: [] });
    await single.rotation.sweep(clock.now());
    expect(single.logger.logged.map(({ message }) => message)).not.toContain(removeThem.message);
  });

  it("completes nothing while a version is left under a previous master key", async () => {
    const { state, tenantKeys } = underMaster(async () => false);
    const { rotation, logger } = await rotationWith(tenantKeys);
    await rotation.sweep(clock.now());
    expect(state.calls).toBe(1);
    expect((await rotation.status()).completeAt).toBeNull();
    expect(logger.logged.map(({ message }) => message)).not.toContain(removeThem.message);
  });

  it("logs a rewrap that fails, completes nothing, and tries again on the next pass", async () => {
    const { state, tenantKeys } = underMaster(async () => {
      throw new Error("the KMS is down");
    });
    const { rotation, logger } = await rotationWith(tenantKeys);
    expect(await rotation.sweep(clock.now())).toBe(0);
    expect(logger.logged).toContainEqual({
      level: "error",
      message: "the tenant's key could not be rewrapped under the master key",
      context: { kid: "m-new", error: expect.objectContaining({ message: "the KMS is down" }) },
    });
    expect((await rotation.status()).completeAt).toBeNull();
    await rotation.sweep(clock.now());
    expect(state.calls).toBe(2);
  });
});

describe("settled", () => {
  it("says whether any key, a person's or the database's, is still under an older version", async () => {
    const storage = await memory().createStorage();
    const wrapper = fakeWrapper("new", ["old", "new"]);
    const rotation = createKeyRotation({
      keys: storage.personalKeys,
      indexKeys: storage.indexKeys,
      checkpoints: storage.checkpointStore,
      tenantKeys: wrapper,
      master: testMaster,
      wrapping: wrappingOver(wrapper),
      clock,
      logger: recordingLogger(),
    });
    expect(await rotation.settled()).toBe(true);
    await addUnder(storage.personalKeys, "new", "c-1");
    expect(await rotation.settled()).toBe(true);
    await addUnder(storage.personalKeys, "old", "c-2");
    expect(await rotation.settled()).toBe(false);
    await removeKeys(storage.personalKeys, "c-2");
    const index = await wrappingOver(fakeWrapper("old")).generate();
    await storage.indexKeys.add(index.stored, clock.now());
    expect(await rotation.settled()).toBe(false);
    await storage.indexKeys.replace(index.stored, { ...index.stored, kid: null });
    expect(await rotation.settled()).toBe(true);

    const current = fakeWrapper("new");
    const alone = createKeyRotation({
      keys: storage.personalKeys,
      checkpoints: storage.checkpointStore,
      tenantKeys: current,
      master: testMaster,
      wrapping: wrappingOver(current),
      clock,
      logger: recordingLogger(),
    });
    expect(await alone.settled()).toBe(true);
    const older = fakeWrapper("new", ["old"]);
    const withoutIndex = createKeyRotation({
      keys: storage.personalKeys,
      checkpoints: storage.checkpointStore,
      tenantKeys: older,
      master: testMaster,
      wrapping: wrappingOver(older),
      clock,
      logger: recordingLogger(),
    });
    expect(await withoutIndex.settled()).toBe(true);
  });
});
