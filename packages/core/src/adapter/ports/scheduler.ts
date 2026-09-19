import type { NewCommand } from "../../contracts/command.ts";
import type { CausationContext } from "../../contracts/metadata.ts";

/**
 * A command waiting for its time: the one mechanism behind `delay` and process timeouts.
 * `dedupeKey` identifies the schedule; scheduling the same key again replaces the previous entry,
 * which is how a process moves or cancels its timeout.
 */
export interface ScheduledCommand {
  readonly dedupeKey: string;
  readonly command: NewCommand;
  readonly executeAt: string;
  readonly context: CausationContext;
  readonly attempts: number;
}

export interface ScheduleArgs {
  readonly dedupeKey: string;
  readonly command: NewCommand;
  readonly executeAt: Date;
  readonly context: CausationContext;
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
  readonly dedupeKey: string;
  readonly error: string;
  /**
   * When to try again. Without it the command is dropped from the schedule; the runner has
   * dead-lettered it.
   */
  readonly retryAt?: Date;
}

export interface ListScheduledArgs {
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Time-based work. Claiming must be atomic: with two workers racing, each due command goes to
 * exactly one of them.
 */
export interface Scheduler {
  schedule(args: ScheduleArgs): Promise<void>;
  cancel(dedupeKey: string): Promise<void>;
  claimDue(args: ClaimDueArgs): Promise<readonly ScheduledCommand[]>;
  complete(dedupeKey: string): Promise<void>;
  fail(args: FailScheduledArgs): Promise<void>;
  list(args?: ListScheduledArgs): Promise<readonly ScheduledCommand[]>;
}
