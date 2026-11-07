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

interface EntryMetadata {
  readonly personId: string;
  readonly forgottenAt: string;
}

const timeKey = (forgottenAt: string): string => String(LATEST_MS - Date.parse(forgottenAt));

export interface CreateKvForgetLedgerArgs {
  readonly namespace: KVNamespace;
  /**
   * Put in front of every key: what keeps one tenant's entries apart.
   */
  readonly prefix: string;
}

export interface CreateKvForgetLedgerFunction {
  (args: CreateKvForgetLedgerArgs): ForgetLedger;
}

/**
 * One key per entry, `<prefix><time>:<eventId>`, with the person and the time in its metadata.
 * KV lists keys in order and starts nowhere but at the first, so the time is kept counting down:
 * the newest entries list first, and a read stops listing at the first entry it does not need.
 */
export const createKvForgetLedger: CreateKvForgetLedgerFunction = ({ namespace, prefix }) => ({
  visibilityDelayMs: KV_LIST_DELAY_MS,
  append: async (entries) => {
    await Promise.all(
      entries.map(({ personId, eventId, forgottenAt }) =>
        namespace.put(`${prefix}${timeKey(forgottenAt)}:${eventId}`, "", {
          metadata: { personId, forgottenAt } satisfies EntryMetadata,
        }),
      ),
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
 * A forget ledger in a Workers KV namespace, for `runtime.personalData.forgetLedger` of an app on
 * Cloudflare: outside the Durable Object, so restoring the object's storage to an earlier time
 * leaves it whole. Every object keeps its entries under its own name, so an object reached through
 * an id without a name fails its start. KV lists a new key within
 * about a minute, so an object that starts reads the ledger once more after `KV_LIST_DELAY_MS`:
 * a forgetting made in the last minute before a restore is applied by then. A binding missing
 * from the object's `env` fails its start with `ConfigurationError`.
 */
export const kvForgetLedger: KvForgetLedgerFunction = ({ binding }) =>
  defineForgetLedger(({ env, tenant }) => {
    const namespace: unknown = Reflect.get(env, binding);
    if (!isKvNamespace(namespace)) {
      throw new ConfigurationError(
        `runtime.personalData.forgetLedger names the KV binding ${binding}, which the Worker's env does not hold: add it under kv_namespaces in wrangler.jsonc`,
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
    });
  });
