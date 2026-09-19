import { describe, expect, it } from "vitest";
import { createMutex } from "./mutex.ts";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMutex", () => {
  it("never overlaps tasks and preserves order", async () => {
    const mutex = createMutex();
    const log: string[] = [];
    let inside = 0;
    const task = (name: string) => async () => {
      inside += 1;
      expect(inside).toBe(1);
      log.push(`${name}:start`);
      await tick();
      log.push(`${name}:end`);
      inside -= 1;
      return name;
    };
    const results = await Promise.all([
      mutex.run(task("a")),
      mutex.run(task("b")),
      mutex.run(task("c")),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("keeps running after a task rejects and drains to the last one", async () => {
    const mutex = createMutex();
    await expect(mutex.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    let done = false;
    void mutex.run(async () => {
      await tick();
      done = true;
    });
    await mutex.drain();
    expect(done).toBe(true);
  });
});
