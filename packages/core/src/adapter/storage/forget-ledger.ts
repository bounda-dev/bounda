/**
 * One forgetting as the ledger keeps it: whom, which `PersonalDataForgotten` said so, and when.
 * Ids and a time, nothing else: the ledger is a suppression list, the one thing about a forgotten
 * person that has to outlive their data.
 */
export interface ForgetLedgerEntry {
  readonly personId: string;
  /**
   * The id of the `PersonalDataForgotten` event, which no other copy of the store gives to another
   * event, unlike its position.
   */
  readonly eventId: string;
  /**
   * The event's timestamp, as `Date.prototype.toISOString` writes it.
   */
  readonly forgottenAt: string;
}

/**
 * Where an entry sits in the ledger, which orders entries by `forgottenAt`, then by `eventId`,
 * both compared by code unit.
 */
export interface ForgetLedgerPosition {
  readonly forgottenAt: string;
  readonly eventId: string;
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
 * The record of every person forgotten, kept outside the database, so restoring a copy of the
 * database taken before someone was forgotten can forget them again. The runtime appends each
 * forgetting to it as soon as it commits, and again from the stream, and reads it when the app
 * starts and every `reconcileEvery` while it runs. One ledger holds one store: a ledger built for
 * a tenant sees only that tenant's entries.
 */
export interface ForgetLedger {
  /**
   * Adds the entries, one per `eventId`: an event names one person at one time, so appending the
   * same entries again leaves the ledger as it was.
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
   * reconciliation when `keepFor` is set. A store that expires entries on its own leaves it out
   * and expires each entry `keepForMs` after its `forgottenAt` instead.
   */
  prune?(args: PruneForgetLedgerArgs): Promise<void>;
  /**
   * The highest value raised under `name` for this ledger's store, `0` for none. What the runtime
   * keeps of the database outside it: a copy restored while the app was stopped holds less than
   * the ledger says the database reached.
   */
  readMark(name: string): Promise<number>;
  /**
   * Raises the mark `name` to `value`, unless it is already that high: a mark never goes down.
   */
  raiseMark(name: string, value: number): Promise<void>;
  /**
   * Releases what the ledger holds open; called when the app stops.
   */
  close?(): Promise<void>;
}

export interface CreateForgetLedgerArgs {
  /**
   * The name of the store the app serves, as `createApp` received it, whose entries the ledger
   * keeps apart from other stores'.
   */
  readonly tenant?: string | undefined;
  /**
   * How long the app keeps each entry after its `forgottenAt`, from `keepFor`; `undefined` keeps
   * entries for good. Only a ledger without `prune` uses it, to expire its entries itself.
   */
  readonly keepForMs?: number | undefined;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface ByForgetLedgerOrderFunction {
  (a: ForgetLedgerPosition, b: ForgetLedgerPosition): number;
}

/**
 * Compares two positions in a ledger's order, for `Array.prototype.sort`: what a ledger of your
 * own sorts by.
 */
export const byForgetLedgerOrder: ByForgetLedgerOrderFunction = (a, b) =>
  byCodeUnit(a.forgottenAt, b.forgottenAt) || byCodeUnit(a.eventId, b.eventId);
