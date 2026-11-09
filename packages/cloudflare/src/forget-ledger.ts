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
// The soonest KV lets a key expire, in seconds from now.
const KV_MIN_TTL_S = 60;

// `categories` is left out for a forgetting of the person as a whole, as every entry written
// before categories was.
interface EntryMetadata {
  readonly personId: string;
  readonly forgottenAt: string;
  readonly categories?: readonly string[];
}

const timeKey = (forgottenAt: string): string => String(LATEST_MS - Date.parse(forgottenAt));

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
}) => ({
  visibilityDelayMs: KV_LIST_DELAY_MS,
  append: async (entries) => {
    const now = Date.now();
    await Promise.all(
      entries.flatMap(({ personId, eventId, forgottenAt, categories }) => {
        const metadata: EntryMetadata = {
          personId,
          forgottenAt,
          ...(categories === null ? {} : { categories }),
        };
        const key = `${prefix}${timeKey(forgottenAt)}:${eventId}`;
        if (keepForMs === undefined) return [namespace.put(key, "", { metadata })];
        const expiresAt = Date.parse(forgottenAt) + keepForMs;
        if (!(expiresAt > now)) return [];
        const expiration = Math.max(
          Math.ceil(expiresAt / 1000),
          Math.floor(now / 1000) + KV_MIN_TTL_S,
        );
        return [namespace.put(key, "", { metadata, expiration })];
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
        found.push({
          personId: metadata.personId,
          eventId: rest.slice(separator + 1),
          forgottenAt: metadata.forgottenAt,
          categories: metadata.categories ?? null,
        });
      }
      if (past || page.list_complete) break;
      cursor = page.cursor;
    }
    return found
      .filter((entry) => after === undefined || byForgetLedgerOrder(entry, after) > 0)
      .sort(byForgetLedgerOrder)
      .slice(0, limit);
  },
});

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
      prefix: `bounda/forget-ledger/${encodeURIComponent(tenant)}/`,
      keepForMs,
    });
  });
