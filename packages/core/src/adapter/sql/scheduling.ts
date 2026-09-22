export interface EarliestDueArgs {
  /**
   * The soonest `execute_at` among commands nobody holds, as the engine returns it.
   */
  readonly unclaimed: unknown;
  /**
   * The oldest `claimed_at` among held commands, as the engine returns it.
   */
  readonly claimed: unknown;
  readonly leaseMs: number;
}

export interface EarliestDueFunction {
  (args: EarliestDueArgs): Date | null;
}

const time = (value: unknown): number | null =>
  value === null || value === undefined ? null : new Date(String(value)).getTime();

/**
 * `Scheduler.nextDueAt` for the SQL schedulers, from two aggregates over the table: a held
 * command is claimable again one millisecond after its lease ends.
 */
export const earliestDue: EarliestDueFunction = ({ unclaimed, claimed, leaseMs }) => {
  const claimedAt = time(claimed);
  const candidates = [time(unclaimed), claimedAt === null ? null : claimedAt + leaseMs + 1].filter(
    (value): value is number => value !== null,
  );
  return candidates.length === 0 ? null : new Date(Math.min(...candidates));
};
