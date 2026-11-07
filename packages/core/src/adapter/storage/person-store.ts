/**
 * What the runtime keeps of a person apart from their key: whether the processing of their data
 * is restricted, and since when. A row outlives its restriction, and a person without a key has
 * one all the same.
 */
export interface StoredPerson {
  readonly person: string;
  /**
   * When `restrict` last took effect, as an ISO timestamp; `null` while processing is not
   * restricted.
   */
  readonly restrictedSince: string | null;
}

/**
 * The persons the runtime knows something about, one row each. Every write answers whether it
 * changed the row, so restricting twice or lifting without a restriction is told apart from the
 * first time, and the caller appends the event of the change only once.
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
}
