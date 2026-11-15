import type {
  DispatchOutcome,
  IdempotencyRecord,
  IdempotencyStore,
} from "../../adapter/storage/idempotency-store.ts";
import type { Snapshot, SnapshotStore } from "../../adapter/storage/snapshot-store.ts";
import { fromBase64, PERSONAL_KEY_ALGORITHM, toBase64 } from "./crypto.ts";

const SALT_BYTES = 16;
// Every record is sealed under a key of its own, so one nonce serves them all.
const RECORD_IV = new Uint8Array(12);
const INFO = new TextEncoder().encode("bounda:at-rest");

/**
 * What the runtime keeps of several persons at once, sealed whole under the database's key: a
 * snapshot's state and a remembered answer. It names no person: forgetting the tenant, whose key
 * wraps the database's, makes it unreadable in every copy.
 */
export interface SealedAtRest {
  readonly $sealed: {
    readonly salt: string;
    readonly data: string;
  };
}

export interface AtRestSealer {
  seal(text: string): Promise<SealedAtRest>;
  open(sealed: SealedAtRest): Promise<string>;
}

export interface IsSealedAtRestFunction {
  (value: unknown): value is SealedAtRest;
}

export const isSealedAtRest: IsSealedAtRestFunction = (value): value is SealedAtRest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const sealed: unknown = Reflect.get(value, "$sealed");
  return (
    Object.keys(value).length === 1 &&
    typeof sealed === "object" &&
    sealed !== null &&
    typeof Reflect.get(sealed, "salt") === "string" &&
    typeof Reflect.get(sealed, "data") === "string"
  );
};

export interface CreateAtRestSealerFunction {
  (base: CryptoKey): AtRestSealer;
}

/**
 * Seals under a key WebCrypto derives for each record, by HKDF with a salt of its own, from the
 * database's key unwrapped as a base: no nonce is ever used twice under one key, however many
 * records are sealed, and no byte of a key reaches JavaScript.
 */
export const createAtRestSealer: CreateAtRestSealerFunction = (base) => {
  const keyOf = (salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: INFO },
      base,
      { name: PERSONAL_KEY_ALGORITHM, length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  return {
    seal: async (text) => {
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const data = await crypto.subtle.encrypt(
        { name: PERSONAL_KEY_ALGORITHM, iv: RECORD_IV },
        await keyOf(salt),
        new TextEncoder().encode(text),
      );
      return { $sealed: { salt: toBase64(salt), data: toBase64(new Uint8Array(data)) } };
    },
    open: async ({ $sealed }) =>
      new TextDecoder().decode(
        await crypto.subtle.decrypt(
          { name: PERSONAL_KEY_ALGORITHM, iv: RECORD_IV },
          await keyOf(fromBase64($sealed.salt)),
          fromBase64($sealed.data),
        ),
      ),
  };
};

export interface SealedSnapshotsFunction {
  (store: SnapshotStore, sealer: AtRestSealer): SnapshotStore;
}

/**
 * The snapshot store with every state sealed at rest. A state kept in the clear, by a version of
 * Bounda that did not seal it, is taken for no snapshot: the stream is folded from its events.
 */
export const sealedSnapshots: SealedSnapshotsFunction = (store, sealer) => ({
  ...store,
  get: async (stream) => {
    const snapshot = await store.get(stream);
    if (snapshot === null) return null;
    let stored: unknown;
    try {
      stored = JSON.parse(snapshot.state);
    } catch {
      return null;
    }
    return isSealedAtRest(stored) ? { ...snapshot, state: await sealer.open(stored) } : null;
  },
  put: async (snapshot: Snapshot) =>
    store.put({ ...snapshot, state: JSON.stringify(await sealer.seal(snapshot.state)) }),
});

export interface SealedAnswersFunction {
  (store: IdempotencyStore, sealer: AtRestSealer): IdempotencyStore;
}

/**
 * The idempotency store with every answer sealed at rest; one kept in the clear by an earlier
 * version of Bounda reads as it is, until it expires.
 */
export const sealedAnswers: SealedAnswersFunction = (store, sealer) => ({
  ...store,
  get: async (args) => {
    const record = await store.get(args);
    if (record === null || !isSealedAtRest(record.outcome)) return record;
    return {
      ...record,
      outcome: JSON.parse(await sealer.open(record.outcome)) as DispatchOutcome,
    } satisfies IdempotencyRecord;
  },
  put: async (args) =>
    store.put({
      ...args,
      outcome: (await sealer.seal(JSON.stringify(args.outcome))) as unknown as DispatchOutcome,
    }),
});
