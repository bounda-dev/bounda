import { ConfigurationError } from "@bounda-dev/core";
import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
  type LedgerRedaction,
  type LedgerRestriction,
} from "@bounda-dev/core/adapter";
import { defineForgetLedger, type ForgetLedgerDefinition } from "@bounda-dev/core/config";

/**
 * How long Workers KV may take to show a written key in `list`.
 */
export const KV_LIST_DELAY_MS = 60_000;

// The latest time a `Date` holds, in milliseconds: keys hold what is left of it, so the newest
// entry lists first. Any time from 1970 on leaves sixteen digits, which sort as numbers do.
const LATEST_MS = 8_640_000_000_000_000;
const LIST_LIMIT = 1_000;
const MARKS_PREFIX = "bounda/forget-ledger-marks/";
// The soonest KV lets a key expire, in seconds from now.
const KV_MIN_TTL_S = 60;
// The most KV takes as a key's metadata, in bytes of its JSON.
const KV_METADATA_BYTES = 1_024;

// `categories` is left out for a forgetting of the person as a whole, as every entry written
// before categories was.
interface EntryMetadata {
  readonly personId: string;
  readonly forgottenAt: string;
  readonly categories?: readonly string[];
  // Absent from a key written before entries kept them.
  readonly reason?: string;
  readonly fingerprints?: readonly string[];
  // The categories and the fingerprints are the key's value instead, as JSON: they did not fit.
  readonly inValue?: true;
}

// What the value of an entry `inValue` holds: always where the entry records a change of
// restrictions or a redaction, whose payload can outgrow the metadata.
interface SpilledEntry {
  readonly categories: readonly string[] | null;
  readonly fingerprints?: readonly string[];
  readonly restriction?: LedgerRestriction;
  readonly redaction?: LedgerRedaction;
}

interface StoredEntry {
  readonly metadata: EntryMetadata;
  readonly value: string;
}

const timeKey = (forgottenAt: string): string => String(LATEST_MS - Date.parse(forgottenAt));

const sizeOf = (metadata: EntryMetadata): number =>
  new TextEncoder().encode(JSON.stringify(metadata)).length;

// A list reads the metadata alone, so an entry is kept there, but for the categories and keys of
// a person with too many to fit, which a read then fetches from the key's value.
const storedOf = ({
  personId,
  forgottenAt,
  categories,
  reason,
  fingerprints,
  restriction,
  redaction,
}: ForgetLedgerEntry): StoredEntry => {
  const full: EntryMetadata = {
    personId,
    forgottenAt,
    ...(categories === null ? {} : { categories }),
    reason,
    ...(fingerprints === undefined ? {} : { fingerprints }),
  };
  if (restriction === undefined && redaction === undefined && sizeOf(full) <= KV_METADATA_BYTES) {
    return { metadata: full, value: "" };
  }
  const spilled: SpilledEntry = {
    categories,
    ...(fingerprints === undefined ? {} : { fingerprints }),
    ...(restriction === undefined ? {} : { restriction }),
    ...(redaction === undefined ? {} : { redaction }),
  };
  return {
    metadata: { personId, forgottenAt, reason, inValue: true },
    value: JSON.stringify(spilled),
  };
};

const isTextList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

// What a value holds of its entry, `null` when it is gone or holds something else: the entry is
// then left out, rather than read as a forgetting of the person as a whole.
const spilledIn = (value: string | null): SpilledEntry | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value ?? "null");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const categories: unknown = Reflect.get(parsed, "categories");
  const fingerprints: unknown = Reflect.get(parsed, "fingerprints");
  const restriction: unknown = Reflect.get(parsed, "restriction");
  const redaction: unknown = Reflect.get(parsed, "redaction");
  if (categories !== null && !isTextList(categories)) return null;
  if (restriction !== undefined && !isRestriction(restriction)) return null;
  if (redaction !== undefined && !isRedaction(redaction)) return null;
  return {
    categories,
    ...(isTextList(fingerprints) ? { fingerprints } : {}),
    ...(restriction === undefined ? {} : { restriction }),
    ...(redaction === undefined ? {} : { redaction }),
  };
};

const isRedaction = (value: unknown): value is LedgerRedaction =>
  typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "events"));

const isRestriction = (value: unknown): value is LedgerRestriction =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string" &&
  typeof Reflect.get(value, "payload") === "object" &&
  Reflect.get(value, "payload") !== null;

/**
 * Where every object's entries live, each under its own name.
 */
export const KV_FORGET_LEDGER_ROOT = "bounda/forget-ledger/";

// When an entry kept `keepForMs` expires, in seconds as KV takes it; `null` once it is past.
const expirationOf = (forgottenAt: string, keepForMs: number, now: number): number | null => {
  const expiresAt = Date.parse(forgottenAt) + keepForMs;
  if (!(expiresAt > now)) return null;
  return Math.max(Math.ceil(expiresAt / 1000), Math.floor(now / 1000) + KV_MIN_TTL_S);
};

const entryOf = (
  metadata: EntryMetadata,
  eventId: string,
  { categories, fingerprints, restriction, redaction }: Partial<SpilledEntry> = metadata,
): ForgetLedgerEntry => {
  const entry: ForgetLedgerEntry = {
    personId: metadata.personId,
    categories: isTextList(categories) ? [...categories] : null,
    eventId,
    forgottenAt: metadata.forgottenAt,
    reason: metadata.reason === "retention" ? "retention" : "requested",
  };
  return {
    ...entry,
    ...(isTextList(fingerprints) ? { fingerprints: [...fingerprints] } : {}),
    ...(restriction === undefined ? {} : { restriction }),
    ...(redaction === undefined ? {} : { redaction }),
  };
};

interface ListedEntry {
  readonly name: string;
  readonly metadata: EntryMetadata;
  readonly forgottenAt: string;
  readonly eventId: string;
}

export interface CreateKvForgetLedgerArgs {
  readonly namespace: KVNamespace;
  /**
   * Put in front of every key: what keeps one tenant's entries apart.
   */
  readonly prefix: string;
  /**
   * Expire each entry this long after its `forgottenAt`, which KV does by itself; kept for good
   * when omitted.
   */
  readonly keepForMs?: number | undefined;
}

export interface CreateKvForgetLedgerFunction {
  (args: CreateKvForgetLedgerArgs): ForgetLedger;
}

/**
 * One key per entry, `<prefix><time>:<eventId>`, with the person and the time in its metadata.
 * KV lists keys in order and starts nowhere but at the first, so the time is kept counting down:
 * the newest entries list first, and a read stops listing at the first entry it does not need.
 * That leaves the oldest entries last, out of reach of a prune, so with `keepForMs` each key
 * expires on its own instead, and an entry already past it is not written.
 */
export const createKvForgetLedger: CreateKvForgetLedgerFunction = ({
  namespace,
  prefix,
  keepForMs,
}) => {
  // Apart from the entries' keys, so no list of entries meets one.
  const markKey = (name: string): string => `${MARKS_PREFIX}${prefix}${name}`;
  return {
    visibilityDelayMs: KV_LIST_DELAY_MS,
    append: async (entries) => {
      const now = Date.now();
      await Promise.all(
        entries.flatMap((entry) => {
          const { eventId, forgottenAt } = entry;
          const { metadata, value } = storedOf(entry);
          const key = `${prefix}${timeKey(forgottenAt)}:${eventId}`;
          if (keepForMs === undefined) return [namespace.put(key, value, { metadata })];
          const expiration = expirationOf(forgottenAt, keepForMs, now);
          return expiration === null ? [] : [namespace.put(key, value, { metadata, expiration })];
        }),
      );
    },
    read: async ({ after, limit }) => {
      const oldest = after === undefined ? null : timeKey(after.forgottenAt);
      const found: ListedEntry[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await namespace.list<EntryMetadata>({
          prefix,
          limit: LIST_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        let past = false;
        for (const { name, metadata } of page.keys) {
          const rest = name.slice(prefix.length);
          const separator = rest.indexOf(":");
          if (oldest !== null && rest.slice(0, separator) > oldest) {
            past = true;
            break;
          }
          if (metadata === null || metadata === undefined) continue;
          found.push({
            name,
            metadata,
            forgottenAt: metadata.forgottenAt,
            eventId: rest.slice(separator + 1),
          });
        }
        if (past || page.list_complete) break;
        cursor = page.cursor;
      }
      const read = found
        .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
        .sort(byForgetLedgerOrder)
        .slice(0, limit);
      // Only the values of the entries handed out, at once.
      const entries = await Promise.all(
        read.map(async ({ name, metadata, eventId }) => {
          if (metadata.inValue !== true) return entryOf(metadata, eventId);
          const spilled = spilledIn(await namespace.get(name));
          return spilled === null ? null : entryOf(metadata, eventId, spilled);
        }),
      );
      return entries.filter((entry) => entry !== null);
    },
    readMark: async (name) => Number((await namespace.get(markKey(name))) ?? 0),
    // KV has no compare: of two instances raising at once the lower may win, which the next raise,
    // of a mark that only grows, puts right.
    raiseMark: async (name, value) => {
      const current = Number((await namespace.get(markKey(name))) ?? 0);
      if (current >= value) return;
      await namespace.put(markKey(name), String(value));
    },
  };
};

export interface KvForgetLedgerOptions {
  /**
   * The name of the KV namespace's binding in `wrangler.jsonc`.
   */
  readonly binding: string;
}

export interface KvForgetLedgerFunction {
  (options: KvForgetLedgerOptions): ForgetLedgerDefinition;
}

const isKvNamespace = (value: unknown): value is KVNamespace =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "put") === "function" &&
  typeof Reflect.get(value, "list") === "function";

/**
 * A forget ledger in a Workers KV namespace, for `runtime.personalData.forgetLedger.store` of an app on
 * Cloudflare: outside the Durable Object, so restoring the object's storage to an earlier time
 * leaves it whole. Every object keeps its entries under its own name, so an object reached through
 * an id without a name fails its start. KV lists a new key within
 * about a minute, so an object that starts reads the ledger once more after `KV_LIST_DELAY_MS`:
 * a forgetting made in the last minute before a restore is applied by then. A binding missing
 * from the object's `env` fails its start with `ConfigurationError`.
 */
export const kvForgetLedger: KvForgetLedgerFunction = ({ binding }) =>
  defineForgetLedger(({ env, tenant, keepForMs }) => {
    const namespace: unknown = Reflect.get(env, binding);
    if (!isKvNamespace(namespace)) {
      throw new ConfigurationError(
        `runtime.personalData.forgetLedger.store names the KV binding ${binding}, which the Worker's env does not hold: add it under kv_namespaces in wrangler.jsonc`,
      );
    }
    // Objects without a name would all read one another's entries under one prefix.
    if (tenant === undefined) {
      throw new ConfigurationError(
        "A KV forget ledger keeps each object's entries under its name, and this object has none: reach it through idFromName",
      );
    }
    return createKvForgetLedger({
      namespace,
      prefix: `${KV_FORGET_LEDGER_ROOT}${encodeURIComponent(tenant)}/`,
      keepForMs,
    });
  });

/**
 * A key of the ledger's namespace as KV lists it.
 */
export interface KvLedgerKey {
  readonly name: string;
  /**
   * When KV expires it, in seconds since 1970; absent for a key kept for good.
   */
  readonly expiration?: number | undefined;
  readonly metadata?: unknown;
}

/**
 * A key written again, as it was, to expire at `expiration`.
 */
export interface KvLedgerPut {
  readonly key: string;
  /**
   * `null` for a key whose value holds the entry's categories and keys: it is written again with
   * the value it has, which the caller reads first, and left alone when that is gone.
   */
  readonly value: string | null;
  readonly expiration: number;
  readonly metadata: unknown;
}

export interface KvForgetLedgerExpiry {
  readonly expire: readonly KvLedgerPut[];
  /**
   * The keys already older than `keepFor`, which KV would not take an expiration for.
   */
  readonly remove: readonly string[];
}

export interface PlanKvForgetLedgerExpiryArgs {
  readonly keys: readonly KvLedgerKey[];
  readonly keepForMs: number;
  readonly now: number;
}

export interface PlanKvForgetLedgerExpiryFunction {
  (args: PlanKvForgetLedgerExpiryArgs): KvForgetLedgerExpiry;
}

/**
 * What gives every entry the expiration `keepFor` sets, for keys written before `keepFor` was set,
 * or while it was longer: a key that expires no later is left alone, and a key that is not an
 * entry of the ledger is never touched.
 */
export const planKvForgetLedgerExpiry: PlanKvForgetLedgerExpiryFunction = ({
  keys,
  keepForMs,
  now,
}) => {
  const expire: KvLedgerPut[] = [];
  const remove: string[] = [];
  for (const { name, expiration: current, metadata } of keys) {
    const forgottenAt: unknown =
      typeof metadata === "object" && metadata !== null
        ? Reflect.get(metadata, "forgottenAt")
        : undefined;
    if (typeof forgottenAt !== "string" || Number.isNaN(Date.parse(forgottenAt))) continue;
    const expiration = expirationOf(forgottenAt, keepForMs, now);
    if (expiration === null) remove.push(name);
    else if (current === undefined || current > expiration) {
      const inValue = Reflect.get(metadata as object, "inValue") === true;
      expire.push({ key: name, value: inValue ? null : "", expiration, metadata });
    }
  }
  return { expire, remove };
};

export interface ExpireKvForgetLedgerArgs {
  readonly namespace: KVNamespace;
  readonly keepForMs: number;
  /**
   * Defaults to now.
   */
  readonly now?: number;
}

export interface ExpireKvForgetLedgerFunction {
  (args: ExpireKvForgetLedgerArgs): Promise<KvForgetLedgerExpiry>;
}

/**
 * Gives every object's entries in the namespace the expiration `keepFor` sets, as
 * `planKvForgetLedgerExpiry` decides, from a Worker, as `bounda forget-ledger expire` does from a
 * terminal. Resolves to what it changed. Run it once after setting or shortening `keepFor`: the
 * entries written from then on expire on their own.
 */
export const expireKvForgetLedger: ExpireKvForgetLedgerFunction = async ({
  namespace,
  keepForMs,
  now = Date.now(),
}) => {
  const keys: KvLedgerKey[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await namespace.list({
      prefix: KV_FORGET_LEDGER_ROOT,
      limit: LIST_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    keys.push(...page.keys);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  const expiry = planKvForgetLedgerExpiry({ keys, keepForMs, now });
  await Promise.all([
    ...expiry.expire.map(async ({ key, value, expiration, metadata }) => {
      const kept = value ?? (await namespace.get(key));
      if (kept !== null) await namespace.put(key, kept, { expiration, metadata });
    }),
    ...expiry.remove.map((key) => namespace.delete(key)),
  ]);
  return expiry;
};
