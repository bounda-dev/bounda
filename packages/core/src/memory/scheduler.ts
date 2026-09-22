import type { ScheduledCommand, Scheduler } from "../adapter/ports/scheduler.ts";

export interface CreateMemorySchedulerFunction {
  (): Scheduler;
}

interface Entry extends ScheduledCommand {
  readonly claimedAt: string | null;
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

/**
 * A scheduler held in memory.
 */
export const createMemoryScheduler: CreateMemorySchedulerFunction = () => {
  const entries = new Map<string, Entry>();

  return {
    schedule: async ({ dedupeKey, command, executeAt, context }) => {
      entries.set(dedupeKey, {
        dedupeKey,
        command,
        executeAt: executeAt.toISOString(),
        context,
        attempts: 0,
        claimedAt: null,
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
      return due.map((entry) => {
        const claimed: Entry = {
          ...entry,
          claimedAt: now.toISOString(),
          attempts: entry.claimedAt === null ? entry.attempts : entry.attempts + 1,
        };
        entries.set(entry.dedupeKey, claimed);
        return toScheduled(claimed);
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
    complete: async (dedupeKey) => {
      entries.delete(dedupeKey);
    },
    fail: async ({ dedupeKey, error, retryAt }) => {
      const existing = entries.get(dedupeKey);
      if (existing === undefined) return;
      if (retryAt === undefined) {
        entries.delete(dedupeKey);
        return;
      }
      entries.set(dedupeKey, {
        ...existing,
        executeAt: retryAt.toISOString(),
        attempts: existing.attempts + 1,
        claimedAt: null,
        lastError: error,
      });
    },
    list: async ({ limit, offset = 0 } = {}) =>
      [...entries.values()]
        .sort(byExecuteAt)
        .slice(offset, limit === undefined ? undefined : offset + limit)
        .map(toScheduled),
  };
};
