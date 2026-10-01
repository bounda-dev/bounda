import { v4 as randomUUID } from "uuid";
import type {
  ClaimedCommand,
  ScheduledClaim,
  ScheduledCommand,
  Scheduler,
} from "../adapter/ports/scheduler.ts";
import { ScheduledClaimLostError } from "../contracts/errors.ts";
import { snapshotMap } from "./transaction.ts";

/**
 * The in-memory scheduler, with a `snapshot` that returns what puts it back the way it is.
 */
export interface MemoryScheduler extends Scheduler {
  snapshot(): () => void;
}

export interface CreateMemorySchedulerFunction {
  (): MemoryScheduler;
}

interface Entry extends ScheduledCommand {
  readonly revision: number;
  readonly claimedAt: string | null;
  readonly claimId: string | null;
  readonly lastError?: string;
}

const byExecuteAt = (a: Entry, b: Entry): number => a.executeAt.localeCompare(b.executeAt);

const toScheduled = ({
  dedupeKey,
  command,
  executeAt,
  context,
  attempts,
}: Entry): ScheduledCommand => ({
  dedupeKey,
  command,
  executeAt,
  context,
  attempts,
});

const sameCommand = (a: ScheduledCommand, b: ScheduledCommand): boolean =>
  JSON.stringify(a.command) === JSON.stringify(b.command) &&
  JSON.stringify(a.context) === JSON.stringify(b.context);

/**
 * A scheduler held in memory.
 */
export const createMemoryScheduler: CreateMemorySchedulerFunction = () => {
  const entries = new Map<string, Entry>();

  const heldBy = (claim: ScheduledClaim): Entry => {
    const entry = entries.get(claim.dedupeKey);
    if (entry?.claimId !== claim.claimId) throw new ScheduledClaimLostError(claim.dedupeKey);
    return entry;
  };

  const release = (entry: Entry): void => {
    entries.set(entry.dedupeKey, { ...entry, claimedAt: null, claimId: null });
  };

  return {
    schedule: async ({ dedupeKey, command, executeAt, context, keepTimingOfSameCommand }) => {
      const scheduled: ScheduledCommand = {
        dedupeKey,
        command,
        executeAt: executeAt.toISOString(),
        context,
        attempts: 0,
      };
      const existing = entries.get(dedupeKey);
      if (
        existing !== undefined &&
        sameCommand(existing, scheduled) &&
        (keepTimingOfSameCommand === true || existing.executeAt === scheduled.executeAt)
      ) {
        return;
      }
      entries.set(dedupeKey, {
        ...scheduled,
        revision: existing === undefined ? 0 : existing.revision + 1,
        claimedAt: existing?.claimedAt ?? null,
        claimId: existing?.claimId ?? null,
      });
    },
    cancel: async (dedupeKey) => {
      entries.delete(dedupeKey);
    },
    claimDue: async ({ now, limit, leaseMs }) => {
      const nowMs = now.getTime();
      const due = [...entries.values()]
        .filter((entry) => new Date(entry.executeAt).getTime() <= nowMs)
        .filter(
          (entry) =>
            entry.claimedAt === null || nowMs - new Date(entry.claimedAt).getTime() > leaseMs,
        )
        .sort(byExecuteAt)
        .slice(0, limit);
      return due.map((entry): ClaimedCommand => {
        const claimId = randomUUID();
        const claimed: Entry = {
          ...entry,
          claimedAt: now.toISOString(),
          claimId,
          attempts: entry.claimedAt === null ? entry.attempts : entry.attempts + 1,
        };
        entries.set(entry.dedupeKey, claimed);
        return { ...toScheduled(claimed), revision: claimed.revision, claimId };
      });
    },
    nextDueAt: async ({ leaseMs }) => {
      const times = [...entries.values()].map((entry) =>
        entry.claimedAt === null
          ? new Date(entry.executeAt).getTime()
          : new Date(entry.claimedAt).getTime() + leaseMs + 1,
      );
      return times.length === 0 ? null : new Date(Math.min(...times));
    },
    complete: async (claim) => {
      const entry = heldBy(claim);
      if (entry.revision === claim.revision) entries.delete(claim.dedupeKey);
      else release(entry);
    },
    fail: async ({ claim, error, retryAt }) => {
      const entry = heldBy(claim);
      if (entry.revision !== claim.revision) {
        release(entry);
        return;
      }
      if (retryAt === undefined) {
        entries.delete(claim.dedupeKey);
        return;
      }
      entries.set(claim.dedupeKey, {
        ...entry,
        executeAt: retryAt.toISOString(),
        attempts: entry.attempts + 1,
        claimedAt: null,
        claimId: null,
        lastError: error,
      });
    },
    defer: async ({ claim, executeAt }) => {
      const entry = heldBy(claim);
      release(
        entry.revision === claim.revision
          ? { ...entry, executeAt: executeAt.toISOString() }
          : entry,
      );
    },
    renew: async ({ claim, now }) => {
      entries.set(claim.dedupeKey, { ...heldBy(claim), claimedAt: now.toISOString() });
    },
    list: async ({ limit, offset = 0 } = {}) =>
      [...entries.values()]
        .sort(byExecuteAt)
        .slice(offset, limit === undefined ? undefined : offset + limit)
        .map(toScheduled),
    snapshot: () => snapshotMap(entries),
  };
};
