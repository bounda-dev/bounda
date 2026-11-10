import type { Hold } from "./hold.ts";

/**
 * What the runtime keeps of a person apart from their key: whether the processing of their data
 * is restricted, and since when, and, while a retention is configured, when they were last active
 * and last forgotten. A row outlives its restriction, and a person without a key has one all the
 * same.
 */
export interface StoredPerson {
  readonly person: string;
  /**
   * When `restrict` last took effect, as an ISO timestamp; `null` while processing is not
   * restricted.
   */
  readonly restrictedSince: string | null;
  /**
   * The timestamp of the last event of the app's aggregates that named them, as recorded; `null`
   * when none has been.
   */
  readonly lastActiveAt: string | null;
  /**
   * The position of the last event recorded on the row, `0` before any: what names them past it
   * is not recorded yet.
   */
  readonly position: number;
  /**
   * The timestamp of the `PersonalDataForgotten` recorded after their last activity; `null` when
   * an event of theirs came after it, or none was recorded.
   */
  readonly forgottenAt: string | null;
  /**
   * The wait a retention sweep set after it could not forget them; `null` when none is set. A
   * record that changes the row clears it.
   */
  readonly hold: Hold | null;
}

/**
 * What a run of events said about one person, recorded at once: `position` is that of the last of
 * those events.
 */
export interface PersonActivity {
  readonly person: string;
  readonly position: number;
  /**
   * Absent when none of the events was an event of the app's aggregates, which leaves
   * `lastActiveAt` as it was.
   */
  readonly lastActiveAt?: string;
  readonly forgottenAt: string | null;
}

export interface ListIdleArgs {
  /**
   * Only the persons last active at or before it; every one when omitted.
   */
  readonly activeBefore?: Date;
  /**
   * Leaves out the persons held past it; holds are not looked at when omitted.
   */
  readonly releasedBy?: Date;
  readonly limit: number;
}

/**
 * The persons the runtime knows something about, one row each. Every restriction write answers
 * whether it changed the row, so restricting twice or lifting without a restriction is told apart
 * from the first time, and the caller appends the event of the change only once.
 */
export interface PersonStore {
  get(person: string): Promise<StoredPerson | null>;
  /**
   * Restricts the processing of the person's data from `since`, creating the row when the person
   * is new. Resolves `false`, leaving `restrictedSince` as it was, when they were restricted
   * already.
   */
  restrict(person: string, since: Date): Promise<boolean>;
  /**
   * Lifts the restriction and keeps the row. Resolves `false` for a person not restricted, known
   * or not, and creates no row for them.
   */
  unrestrict(person: string): Promise<boolean>;
  /**
   * Records what events said about the person, creating the row when the person is new, unless
   * the row already records an event at `position` or later: a run recorded again, or late, by a
   * subscriber that lost its checkpoint to another, changes nothing. A record that changes the row
   * clears its hold.
   */
  record(activity: PersonActivity): Promise<void>;
  /**
   * The persons a retention may forget, least recently active first: active once, not forgotten
   * since, and not restricted.
   */
  listIdle(args: ListIdleArgs): Promise<readonly StoredPerson[]>;
  /**
   * Sets the person's hold, replacing the one they had, only while they are still last active at
   * `lastActiveAt` and not forgotten since: a hold meant for an idle person never lands on one a
   * record has just made active. A person without a row is left without.
   */
  hold(person: string, lastActiveAt: string, hold: Hold): Promise<void>;
  /**
   * The earliest end of a hold past `after` among the persons `listIdle` lists; `null` when none
   * is held past it.
   */
  nextHoldEnd(after: Date): Promise<Date | null>;
  /**
   * How many persons `listIdle` lists with `activeBefore`, whatever their holds.
   */
  countIdle(args: Pick<ListIdleArgs, "activeBefore">): Promise<number>;
  /**
   * Clears every person's hold, and resolves to how many it cleared: what the runtime does once the
   * database went back to a copy, whose holds count failures the copy undid.
   */
  releaseHolds(): Promise<number>;
}
