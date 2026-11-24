import {
  fenceError,
  nextFence,
  type TenantFence,
  type TenantFenceStore,
} from "../adapter/storage/tenant-fence.ts";

// The methods of each store that write, which the fence puts behind it.
export const FENCED_WRITES = {
  eventStore: ["append", "appendAll", "reseal", "reserve", "release"],
  inboxLedger: ["tryClaim", "complete", "fail", "renew"],
  deadLetterStore: [
    "add",
    "updateStatus",
    "remove",
    "reseal",
    "forget",
    "purge",
    "removeHeld",
    "clear",
  ],
  scheduler: [
    "schedule",
    "cancel",
    "claimDue",
    "complete",
    "fail",
    "defer",
    "renew",
    "reseal",
    "forget",
  ],
  idempotencyStore: ["put", "erase", "reseal", "purge", "forget", "clear"],
  personalKeys: [
    "add",
    "remove",
    "retain",
    "touch",
    "holdDue",
    "rewrap",
    "hold",
    "supersede",
    "destroySuperseded",
    "clear",
    "releaseHolds",
    "releaseDueHolds",
  ],
  persons: ["restrict", "unrestrict", "record", "hold", "releaseHolds"],
  recipients: ["disclose", "forget", "declare", "presumeThrough", "rename", "caughtUp"],
  snapshotStore: ["put", "remove", "forget", "clear"],
  subscriberFailures: ["record", "resolve", "reseal", "remove", "clear"],
  indexKeys: ["add", "rewrap", "supersede", "dropPrevious", "replace", "clear"],
  checkpointStore: ["set", "compareAndSet", "remove"],
  table: ["upsert", "insert", "update", "delete"],
} as const;

export interface MemoryTenantFence {
  readonly store: TenantFenceStore;
  // Runs `work` as one write behind the fence: refused at once while the fence is not open, but
  // a forgotten one with `pass`, and waited for by `set` until it ends.
  write<T>(work: () => Promise<T>, pass?: "forgotten"): Promise<T>;
  // `target` with each of `writes` run through `write`.
  guard<T extends object>(target: T, writes: readonly (keyof T)[], pass?: "forgotten"): T;
  rows(): readonly Readonly<Record<string, unknown>>[];
}

export interface CreateMemoryTenantFenceFunction {
  (): MemoryTenantFence;
}

export const createMemoryTenantFence: CreateMemoryTenantFenceFunction = () => {
  let fence: TenantFence = { state: "open" };
  let running = 0;
  let drained: (() => void)[] = [];
  const write = async <T>(work: () => Promise<T>, pass?: "forgotten"): Promise<T> => {
    if (fence.state !== "open" && fence.state !== pass) throw fenceError(fence);
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      if (running === 0) {
        const waiting = drained;
        drained = [];
        for (const resume of waiting) resume();
      }
    }
  };
  return {
    store: {
      read: async () => fence,
      set: async (asked) => {
        fence = nextFence(fence, asked);
        const set = fence;
        if (running > 0) await new Promise<void>((resume) => drained.push(resume));
        return set;
      },
    },
    write,
    guard: (target, writes, pass) => {
      const fenced: ReadonlySet<PropertyKey> = new Set(writes);
      return new Proxy(target, {
        get: (object, property, receiver) => {
          const member: unknown = Reflect.get(object, property, receiver);
          // Every name `writes` lists is a method.
          if (!fenced.has(property)) return member;
          return (...args: unknown[]) =>
            write(
              async () => (member as (...given: unknown[]) => unknown).apply(object, args),
              pass,
            );
        },
      });
    },
    rows: () =>
      fence.state === "open"
        ? []
        : [{ scope: "app", tenant: fence.tenant, state: fence.state, since: fence.since }],
  };
};
