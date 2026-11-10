import { ConfigurationError } from "@bounda-dev/core";
import {
  byForgetLedgerOrder,
  type ForgetLedger,
  type ForgetLedgerEntry,
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
}

const timeKey = (forgottenAt: string): string => String(LATEST_MS - Date.parse(forgottenAt));

const sizeOf = (metadata: EntryMetadata): number =>
  new TextEncoder().encode(JSON.stringify(metadata)).length;

// An entry whose keys do not fit beside its categories is kept without them, which any key
// matches: a reconciliation then forgets again a key given after it too, never a category it did
// not ask for.
const metadataOf = ({
  personId,
  forgottenAt,
  categories,
  reason,
  fingerprints,
}: ForgetLedgerEntry): EntryMetadata => {
  const named: EntryMetadata = {
    personId,
    forgottenAt,
    ...(categories === null ? {} : { categories }),
    reason,
  };
  if (fingerprints === undefined) return named;
  const full: EntryMetadata = { ...named, fingerprints };
  return sizeOf(full) > KV_METADATA_BYTES ? named : full;
};

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

const entryOf = (metadata: EntryMetadata, eventId: string): ForgetLedgerEntry => {
  const entry: ForgetLedgerEntry = {
    personId: metadata.personId,
    categories: Array.isArray(metadata.categories) ? [...metadata.categories] : null,
    eventId,
    forgottenAt: metadata.forgottenAt,
    reason: metadata.reason === "retention" ? "retention" : "requested",
  };
  return Array.isArray(metadata.fingerprints)
    ? { ...entry, fingerprints: [...metadata.fingerprints] }
    : entry;
};

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
          const metadata = metadataOf(entry);
          const key = `${prefix}${timeKey(forgottenAt)}:${eventId}`;
          if (keepForMs === undefined) return [namespace.put(key, "", { metadata })];
          const expiration = expirationOf(forgottenAt, keepForMs, now);
          return expiration === null ? [] : [namespace.put(key, "", { metadata, expiration })];
        }),
      );
    },
    read: async ({ after, limit }) => {
      const oldest = after === undefined ? null : timeKey(after.forgottenAt);
      const found: ForgetLedgerEntry[] = [];
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
          found.push(entryOf(metadata, rest.slice(separator + 1)));
        }
        if (past || page.list_complete) break;
        cursor = page.cursor;
      }
      return found
        .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
        .sort(byForgetLedgerOrder)
        .slice(0, limit);
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
  readonly value: "";
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
      expire.push({ key: name, value: "", expiration, metadata });
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
    ...expiry.expire.map(({ key, value, expiration, metadata }) =>
      namespace.put(key, value, { expiration, metadata }),
    ),
    ...expiry.remove.map((key) => namespace.delete(key)),
  ]);
  return expiry;
};
