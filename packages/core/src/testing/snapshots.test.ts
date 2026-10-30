import { describe, expect, it, vi } from "vitest";
import { SnapshotError } from "../contracts/errors.ts";
import { silentLogger } from "../contracts/logger.ts";
import { createApp } from "../kernel/app.ts";
import { memory } from "../memory/index.ts";
import type { PayloadArgs } from "../modules/payload.ts";
import type { Registry } from "../modules/registry.ts";
import { createTestApp } from "./index.ts";

interface State {
  readonly count: number;
}

class Clock {}

const counter = (evolve: (state: State) => object) =>
  ({
    aggregates: {
      counter: {
        state: { initialState: { count: 0 } satisfies State },
        stateFingerprint: "counter",
        events: { incremented: { evolve: ({ state }: { state: State }) => evolve(state) } },
        commands: {
          increment: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ counterId: z.string() }),
              handler: ({ events }: { events: { incremented: () => unknown } }) => [
                events.incremented(),
              ],
            },
          },
          read: {
            module: {
              payload: ({ z }: PayloadArgs) => z.object({ counterId: z.string() }),
              handler: ({ state }: { state: State }) => {
                seen.push(state.count);
                return [];
              },
            },
          },
        },
        policies: {},
        processes: {},
      },
    },
    readModels: {},
  }) as const satisfies Registry;

const seen: number[] = [];
const config = { runtime: { overrides: { counter: { snapshot: { every: 2 } } } } };

describe("snapshots in a test app", () => {
  it("writes them when the app runs until idle and loads the state from them, checking every load", async () => {
    const evolve = vi.fn((state: State) => ({ count: state.count + 1 }));
    const { app } = await createTestApp({ registry: counter(evolve), config });
    await app.commands.increment({ counterId: "c-1" });
    await app.commands.increment({ counterId: "c-1" });
    expect(evolve).toHaveBeenCalledTimes(1);
    await app.runUntilIdle();
    const lag = await app.getLag();
    expect(lag.subscribers.map((entry) => entry.subscriber)).toEqual(["snapshot:counter"]);
    expect(lag.maxLag).toBe(0);
    // The subscriber folded the two events once; the next command folds none from the snapshot,
    // and the check against the stream folds the two again.
    evolve.mockClear();
    await app.commands.read({ counterId: "c-1" });
    expect(seen.at(-1)).toBe(2);
    expect(evolve).toHaveBeenCalledTimes(2);
    await app.stop();
  });

  it("fails a command whose state from the snapshot is not the stream's", async () => {
    let bonus = 0;
    const { app } = await createTestApp({
      registry: counter((state) => ({ count: state.count + 1 + bonus })),
      config,
    });
    await app.commands.increment({ counterId: "c-1" });
    await app.commands.increment({ counterId: "c-1" });
    await app.runUntilIdle();
    bonus = 1;
    await expect(app.commands.read({ counterId: "c-1" })).rejects.toThrow(SnapshotError);
    await app.stop();
  });

  it("makes runUntilIdle throw for a state that cannot be snapshotted", async () => {
    const { app } = await createTestApp({
      registry: counter((state) => ({ count: state.count + 1, clock: new Clock() })),
      config,
    });
    await app.commands.increment({ counterId: "c-1" });
    await app.commands.increment({ counterId: "c-1" });
    await expect(app.runUntilIdle()).rejects.toThrow(
      new SnapshotError(
        "State of counter:c-1 cannot be snapshotted: Cannot stringify arbitrary non-POJOs",
      ),
    );
    await app.stop();
  });
});

describe("snapshots and idempotency keys", () => {
  it("load a keyed command's state from the snapshot, and answer its repeat without loading at all", async () => {
    const evolve = vi.fn((state: State) => ({ count: state.count + 1 }));
    const adapter = memory();
    const app = await createApp({
      registry: counter(evolve),
      config: {
        storage: adapter,
        runtime: { overrides: { counter: { snapshot: { every: 2, verify: 0 } } } },
      },
      logger: silentLogger,
    });
    await app.commands.increment({ counterId: "c-1" });
    await app.commands.increment({ counterId: "c-1" });
    await app.runUntilIdle();
    const storage = await adapter.createStorage({ logger: silentLogger });
    const snapshot = await storage.snapshotStore.get({
      aggregateType: "counter",
      aggregateId: "c-1",
    });
    expect(snapshot).toMatchObject({ version: 2 });
    evolve.mockClear();
    const first = await app.commands.read({ counterId: "c-1" }, { idempotencyKey: "k-1" });
    expect(seen.at(-1)).toBe(2);
    expect(evolve).not.toHaveBeenCalled();
    const reads = seen.length;
    const again = await app.commands.read({ counterId: "c-1" }, { idempotencyKey: "k-1" });
    expect(again).toEqual(first);
    expect(seen).toHaveLength(reads);
    expect(evolve).not.toHaveBeenCalled();
    expect(
      await storage.snapshotStore.get({ aggregateType: "counter", aggregateId: "c-1" }),
    ).toEqual(snapshot);
    await app.stop();
  });
});
