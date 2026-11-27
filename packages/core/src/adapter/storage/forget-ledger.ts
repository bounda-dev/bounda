import { recipientTransferOf } from "../../kernel/recipients/transfer.ts";
import {
  PERSONAL_DATA_FORGOTTEN_REASONS,
  type PersonalDataForgottenReason,
  type PROCESSING_RESTRICTED_EVENT,
  type PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT,
  type PROCESSING_RESTRICTION_LIFTED_EVENT,
  type ProcessingRestrictedPayload,
  type ProcessingRestrictionLiftAnnouncedPayload,
  type ProcessingRestrictionLiftedPayload,
  type RedactedEvent,
} from "../../modules/bounda-events.ts";
import {
  COUNTRY_CODES,
  type CountryCode,
  type PartialAdequacy,
  type RecipientTransfer,
  TRANSFER_SAFEGUARDS,
  type TransferSafeguard,
} from "../../modules/recipient.ts";
import type { TenantFenceStore } from "./tenant-fence.ts";

/**
 * A change of a person's restrictions as the ledger keeps it: the event that records it, with its
 * payload, which holds ids, grounds, category names and times, and every restriction the person
 * has after it, so a restore that lost it applies it again as it stands.
 */
export type LedgerRestriction =
  | {
      readonly type: typeof PROCESSING_RESTRICTED_EVENT;
      readonly payload: ProcessingRestrictedPayload;
    }
  | {
      readonly type: typeof PROCESSING_RESTRICTION_LIFT_ANNOUNCED_EVENT;
      readonly payload: ProcessingRestrictionLiftAnnouncedPayload;
    }
  | {
      readonly type: typeof PROCESSING_RESTRICTION_LIFTED_EVENT;
      readonly payload: ProcessingRestrictionLiftedPayload;
    };

/**
 * A redaction as the ledger keeps it: the events and fields it was asked for, ids and names
 * alone, so a restore that lost it seals those fields again.
 */
export interface LedgerRedaction {
  readonly events: readonly RedactedEvent[];
}

/**
 * A disclosure as the ledger keeps it: the port and its recipient's identity then, and the category
 * of what it received, ids and names alone, so a restore that lost it still tells the recipient.
 */
export interface LedgerDisclosure {
  readonly port: string;
  readonly recipient: string;
  readonly kind: string;
  readonly country: string;
  /**
   * The transfer out of the European Economic Area the disclosure rested on when it was first
   * recorded, as `PersonRecipient.transfer` named it then, `null` for a recipient in it: kept as
   * it was, since the regime of a country, the article of a safeguard and a partial adequacy
   * decision are those of that day.
   */
  readonly transfer: RecipientTransfer | null;
  readonly category: string;
}

/**
 * Where the database stood when an intention was written: the position of its newest event and its
 * restore generation, which only goes up, and which every restore counted moves past what the
 * database reached before.
 */
export interface LedgerReached {
  readonly position: number;
  readonly generation: number;
}

/**
 * One forgetting as the ledger keeps it: whom, which `PersonalDataForgotten` says so, when, why,
 * which of their categories it was asked for, and which keys it covers. Ids, names, a time and
 * fingerprints, nothing else: the ledger is a suppression list, the one thing about a forgotten
 * person that has to outlive their data. The runtime writes it before the forgetting commits, so
 * an entry may name an event no store holds.
 */
export interface ForgetLedgerEntry {
  readonly personId: string;
  /**
   * The categories the forgetting was asked for, `null` for the person as a whole: forgetting
   * them again forgets those again, as the request did.
   */
  readonly categories: readonly string[] | null;
  /**
   * The id of the `PersonalDataForgotten` event, which no other copy of the store gives to another
   * event, unlike its position.
   */
  readonly eventId: string;
  /**
   * The event's timestamp, as `Date.prototype.toISOString` writes it.
   */
  readonly forgottenAt: string;
  readonly reason: PersonalDataForgottenReason;
  /**
   * The fingerprints of the keys in force the forgetting covered when it was asked: the
   * reconciliation commits it again only while the person holds one of them, since any other key
   * was given to them after. Absent from an entry written by a Bounda that did not record them, which any key
   * matches.
   */
  readonly fingerprints?: readonly string[];
  /**
   * Present on an entry that records a change of the person's restrictions rather than a
   * forgetting, whose `eventId` and `forgottenAt` are that event's, `reason` `requested` and
   * `categories` `null`: a restriction has to outlive a restore as a forgetting does.
   */
  readonly restriction?: LedgerRestriction;
  /**
   * Present on an entry that records a redaction rather than a forgetting, whose `eventId` and
   * `forgottenAt` are its `PersonalDataRedacted`'s, `reason` `requested` and `categories` `null`:
   * a value made unreadable has to stay so after a restore as a forgotten one does.
   */
  readonly redaction?: LedgerRedaction;
  /**
   * Present on an entry that records a disclosure to a recipient rather than a forgetting, whose
   * `eventId` is derived from the person, the port, the recipient and the category, `forgottenAt`
   * is when it was first recorded, `reason` `requested` and `categories` `null`: whom a recipient
   * holds data of has to outlive a restore, so it is told when they are forgotten.
   */
  readonly disclosure?: LedgerDisclosure;
  /**
   * `false` on an intention the runtime wrote before its commit, until the stream copies the
   * commit, which leaves it out: a committed entry the database lacks was undone by a restore,
   * an intention may never have committed. Absent, the entry is committed, as every entry written
   * before Bounda told them apart. A disclosure's entry stays `false`: the stream copies none.
   */
  readonly committed?: false;
  /**
   * Where the database stood when the runtime wrote the entry as an intention, which a ledger keeps
   * with it: what tells a restore of a copy taken before the intention though its commit never
   * reached the ledger. A ledger may drop it once the entry is committed. Absent from an entry the
   * stream wrote, and from one written before Bounda recorded it.
   */
  readonly reached?: LedgerReached;
}

/**
 * Where an entry sits in the ledger, which orders entries by `forgottenAt`, then by `eventId`,
 * both compared by code unit.
 */
export interface ForgetLedgerPosition {
  readonly forgottenAt: string;
  readonly eventId: string;
}

/**
 * A value raised under one of the ledger's marks, and when: `raisedAt` as
 * `Date.prototype.toISOString` writes it, the clock of the instance that raised it.
 */
export interface ForgetLedgerMark {
  readonly value: number;
  readonly raisedAt: string;
}

export interface ReadForgetLedgerArgs {
  /**
   * Read the entries past this position; from the first when omitted.
   */
  readonly after?: ForgetLedgerPosition;
  readonly limit: number;
}

export interface PruneForgetLedgerArgs {
  /**
   * Remove the entries whose `forgottenAt` is earlier than this, as `Date.prototype.toISOString`
   * writes it.
   */
  readonly before: string;
}

/**
 * The record of every person forgotten, and of every change of a person's restrictions, kept
 * outside the database, so restoring a copy of the database taken before someone was forgotten or
 * restricted forgets or restricts them again. The runtime appends each
 * forgetting to it before the forgetting commits, and again from the stream once it has, and
 * reads it when the app starts and every `reconcileEvery` while it runs. One ledger holds one
 * store: a ledger built for a tenant sees only that tenant's entries.
 */
export interface ForgetLedger {
  /**
   * Adds the entries, one per `eventId`, each with every field it has: an event names one person
   * at one time, so appending the same entries again leaves the ledger as it was. The one field an
   * entry appended again changes is `committed`: an entry appended committed, in this call or
   * before, reads committed from then on, whatever is appended after.
   */
  append(entries: readonly ForgetLedgerEntry[]): Promise<void>;
  /**
   * Up to `limit` entries past `after`, in the ledger's order.
   */
  read(args: ReadForgetLedgerArgs): Promise<readonly ForgetLedgerEntry[]>;
  /**
   * How long an entry may take after `append` to show in `read`, for a store whose reads are
   * eventually consistent: the app reads the ledger once more that long after it starts.
   */
  readonly visibilityDelayMs?: number;
  /**
   * Removes the entries older than `before`, which the runtime calls with every periodic
   * reconciliation when `keepFor` is set, and `pruneTenantForgetLedger` with no app running. A store that expires entries on its own leaves it out
   * and expires each entry `keepForMs` after its `forgottenAt` instead.
   */
  prune?(args: PruneForgetLedgerArgs): Promise<void>;
  /**
   * Every tenant whose entries the ledger's store holds, this ledger's own and others', in
   * code-unit order: what `pruneTenantForgetLedger` reads to reach every tenant of a store that
   * holds several. A store that cannot list them leaves it out.
   */
  tenants?(): Promise<readonly string[]>;
  /**
   * What tells the store the ledger keeps its entries in, compared with `===`: ledgers with one
   * `storeId` share a store, whichever tenant each was opened for, and
   * `bounda forget-ledger prune --all-tenants` visits each store once by it. An adapter's ledger
   * gives one. A ledger of your own that a configuration defines anew for every tenant gives one too,
   * such as the name of its database, never a secret; without it, each definition is a store of its
   * own.
   */
  readonly storeId?: unknown;
  /**
   * The values raised under `name` for this ledger's store, highest first, each with when it was
   * raised; none for a mark never raised. What the runtime keeps of the database outside it: a
   * copy restored while the app was stopped holds less than the ledger says the database reached.
   * A ledger whose reads show every write keeps the highest value alone, with the time it was
   * first raised. One whose reads lag, with `visibilityDelayMs`, keeps every value with each time
   * it was raised, until `pruneMarks` lets them go: what tells the runtime a value raised before it
   * started, which a read may show late, from one raised since.
   */
  readMark(name: string): Promise<readonly ForgetLedgerMark[]>;
  /**
   * Raises the mark `name` to `mark.value`, at `mark.raisedAt`: a mark never goes down. A ledger
   * that keeps the highest value alone keeps the time it was first raised with; one whose reads
   * lag keeps each time it was raised.
   */
  raiseMark(name: string, mark: ForgetLedgerMark): Promise<void>;
  /**
   * Removes the values of the mark `name` raised before `before`, but the highest of them: what
   * the runtime calls on a ledger whose reads lag once it has compared them with the database. A
   * ledger that keeps the highest value alone leaves it out.
   */
  pruneMarks?(name: string, before: string): Promise<void>;
  /**
   * Removes the entries and marks of this ledger's store, other stores' left as they were, and
   * resolves `true` once it removed every one it found, `false` when it removed part only, to be
   * called again, as a store that deletes one key a call does within what one call may do: what
   * the runtime calls once its tenant is forgotten and every recipient of the tenant's data told,
   * when nothing can need them any longer. It leaves the fence as it is, so nothing is appended
   * afterwards. A call that fails is made again.
   */
  clear(): Promise<boolean>;
  /**
   * The fence of this ledger's store, as `TenantFenceStore` describes it: `append` and `raiseMark`
   * reject with its error, writing nothing, once it is raised, whatever instance calls them, and
   * one under way when it is raised ends before `set` resolves. `read`, `readMark`, `pruneMarks`, `prune` and
   * `clear` go on. A ledger several instances write must check it in the same atomic step as the
   * write; one only the tenant's own object writes, as KV is, may check it in that object.
   */
  readonly fence: TenantFenceStore;
  /**
   * Releases what the ledger holds open; called when the app stops.
   */
  close?(): Promise<void>;
}

export interface CreateForgetLedgerArgs {
  /**
   * The tenant the app serves, whose entries the ledger keeps apart from other tenants':
   * `DEFAULT_TENANT` for an app that names none.
   */
  readonly tenant: string;
  /**
   * How long the app keeps each entry after its `forgottenAt`, from `keepFor`; `undefined` keeps
   * entries until `clear`. Only a ledger without `prune` uses it, to expire its entries itself.
   */
  readonly keepForMs?: number | undefined;
}

export interface ByCodeUnitFunction {
  (a: string, b: string): number;
}

// What a ledger compares its ordering columns and its tenants by, as SQLite does.
export const byCodeUnit: ByCodeUnitFunction = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export interface ForgottenReasonOfFunction {
  (stored: unknown): PersonalDataForgottenReason;
}

/**
 * The reason a ledger of your own stored, read back: one Bounda knows, or `requested` for anything
 * else, as for an entry written before the reason was stored.
 */
export const forgottenReasonOf: ForgottenReasonOfFunction = (stored) =>
  PERSONAL_DATA_FORGOTTEN_REASONS.includes(stored as PersonalDataForgottenReason)
    ? (stored as PersonalDataForgottenReason)
    : "requested";

export interface ByForgetLedgerOrderFunction {
  (a: ForgetLedgerPosition, b: ForgetLedgerPosition): number;
}

/**
 * Compares two positions in a ledger's order, for `Array.prototype.sort`: what a ledger of your
 * own sorts by.
 */
export const byForgetLedgerOrder: ByForgetLedgerOrderFunction = (a, b) =>
  byCodeUnit(a.forgottenAt, b.forgottenAt) || byCodeUnit(a.eventId, b.eventId);

export interface LedgerDisclosureOfFunction {
  (stored: unknown): LedgerDisclosure | null;
}

const isText = (value: unknown): value is string => typeof value === "string";

const isSafeguard = (value: unknown): value is TransferSafeguard =>
  TRANSFER_SAFEGUARDS.includes(value as TransferSafeguard);

const PARTIAL_ADEQUACY_FIELDS = ["scope", "decision", "celex", "covers", "condition"] as const;

const partialAdequacyOf = (value: unknown): PartialAdequacy | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const [scope, decision, celex, covers, condition]: unknown[] = PARTIAL_ADEQUACY_FIELDS.map(
    (field) => Reflect.get(value, field),
  );
  return isText(scope) && isText(decision) && isText(celex) && isText(covers) && isText(condition)
    ? { scope, decision, celex, covers, condition }
    : undefined;
};

const transferOf = (value: unknown): RecipientTransfer | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const safeguard: unknown = Reflect.get(value, "safeguard");
  const article: unknown = Reflect.get(value, "article");
  const regime: unknown = Reflect.get(value, "regime");
  const partialAdequacy = partialAdequacyOf(Reflect.get(value, "partialAdequacy"));
  return isSafeguard(safeguard) &&
    isText(article) &&
    isText(regime) &&
    partialAdequacy !== undefined
    ? { safeguard, article, regime: regime as RecipientTransfer["regime"], partialAdequacy }
    : undefined;
};

/**
 * A disclosure a ledger stored, read back: one as `LedgerDisclosure` has it, its transfer and any
 * partial adequacy decision as they were kept, or one written before disclosures kept their transfer, with the `safeguard` alone,
 * whose transfer it derives from its country and safeguard as they read now. `null` for anything
 * else, which a ledger must not read as an entry without a disclosure: that would be a forgetting
 * of the person as a whole.
 */
export const ledgerDisclosureOf: LedgerDisclosureOfFunction = (stored) => {
  if (typeof stored !== "object" || stored === null) return null;
  const [port, recipient, kind, country, category]: unknown[] = [
    "port",
    "recipient",
    "kind",
    "country",
    "category",
  ].map((field) => Reflect.get(stored, field));
  if (!(isText(port) && isText(recipient) && isText(kind) && isText(country) && isText(category))) {
    return null;
  }
  const identity = { port, recipient, kind, country };
  if (Object.hasOwn(stored, "transfer")) {
    const transfer = transferOf(Reflect.get(stored, "transfer"));
    return transfer === undefined ? null : { ...identity, transfer, category };
  }
  const safeguard: unknown = Reflect.get(stored, "safeguard") ?? null;
  if (safeguard === null) return { ...identity, transfer: null, category };
  if (!isSafeguard(safeguard) || !COUNTRY_CODES.includes(country as CountryCode)) return null;
  return {
    ...identity,
    transfer: recipientTransferOf(country as CountryCode, safeguard),
    category,
  };
};
