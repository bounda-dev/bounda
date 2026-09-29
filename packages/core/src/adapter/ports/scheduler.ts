import type { NewCommand } from "../../contracts/command.ts";
import type { CausationContext } from "../../contracts/metadata.ts";

/**
 * A command waiting for its time. `dedupeKey` identifies the entry: scheduling the same key
 * again replaces it.
 */
export interface ScheduledCommand {
  readonly dedupeKey: string;
  readonly command: NewCommand;
  readonly executeAt: string;
  readonly context: CausationContext;
  readonly attempts: number;
}

/**
 * Who holds a claimed command and which version of it they hold. `claimId` is new on every claim;
 * `revision` grows each time the key is scheduled again with something different. `complete`,
 * `fail` and `defer` act only while both still match, so a worker finishing a command that was
 * rescheduled meanwhile, or whose lease another worker took over, cannot undo the newer state.
 */
export interface ScheduledClaim {
  readonly dedupeKey: string;
  readonly revision: number;
  readonly claimId: string;
}

/**
 * A command handed out by `claimDue`, with the claim to complete or fail it by.
 */
export interface ClaimedCommand extends ScheduledCommand, ScheduledClaim {}

export interface ScheduleArgs {
  readonly dedupeKey: string;
  readonly command: NewCommand;
  readonly executeAt: Date;
  readonly context: CausationContext;
  /**
   * When the key already holds this very command with this context, leave the entry as it is,
   * its time and attempts included, instead of moving it to `executeAt`: a retry that is backing
   * off stays backed off.
   */
  readonly keepTimingOfSameCommand?: boolean;
}

export interface ClaimDueArgs {
  readonly now: Date;
  readonly limit: number;
  /**
   * How long a claimed command stays owned. A claim older than this is handed out again.
   */
  readonly leaseMs: number;
}

export interface FailScheduledArgs {
  readonly claim: ScheduledClaim;
  readonly error: string;
  /**
   * Without it the command is dropped: the runner has dead-lettered it.
   */
  readonly retryAt?: Date;
}

export interface DeferScheduledArgs {
  readonly claim: ScheduledClaim;
  readonly executeAt: Date;
}

export interface NextDueAtArgs {
  /**
   * The lease `claimDue` is called with: a claimed command becomes claimable again once it has
   * passed.
   */
  readonly leaseMs: number;
}

export interface ListScheduledArgs {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Claiming must be atomic: with two workers racing, each due command goes to exactly one of them.
 */
export interface Scheduler {
  /**
   * Replaces what the key held. A command being run keeps its claim, so the new version runs once
   * the current run ends, never beside it. Scheduling exactly what the key holds changes nothing.
   */
  schedule(args: ScheduleArgs): Promise<void>;
  /**
   * Removes the key's command, claimed or not.
   */
  cancel(dedupeKey: string): Promise<void>;
  claimDue(args: ClaimDueArgs): Promise<readonly ClaimedCommand[]>;
  /**
   * The earliest moment `claimDue` could hand something out: the soonest execution time of a
   * command nobody holds, or the end of the oldest lease; `null` when nothing is scheduled. For a
   * host without a polling loop, such as a Durable Object, to arm its alarm.
   */
  nextDueAt(args: NextDueAtArgs): Promise<Date | null>;
  /**
   * Removes a command that ran. If it was rescheduled meanwhile, the claim is released instead and
   * the new version stays; if the claim is no longer this one, nothing happens.
   */
  complete(claim: ScheduledClaim): Promise<void>;
  /**
   * Reschedules a command that failed, or drops it without `retryAt`, under the same rules as
   * `complete`.
   */
  fail(args: FailScheduledArgs): Promise<void>;
  /**
   * Hands a claimed command back to run again at `executeAt` without counting an attempt: for
   * work that was not ready yet rather than work that failed. Same rules as `complete`.
   */
  defer(args: DeferScheduledArgs): Promise<void>;
  list(args?: ListScheduledArgs): Promise<readonly ScheduledCommand[]>;
}
