/**
 * The names a rebuild fences itself with: the lock every step of it takes, and the checkpoint that
 * counts the rebuilds opened for the read model.
 */
export interface RebuildFencing {
  readonly lock: string;
  readonly generation: string;
}

export interface RebuildFencingFunction {
  (readModel: string): RebuildFencing;
}

/**
 * Opening a rebuild takes `lock`, bumps the `generation` checkpoint and keeps the value it set.
 * Every later step takes `lock` again and goes ahead only while the checkpoint still holds that
 * value; otherwise another rebuild has taken over, and a batch or the commit throws
 * `RebuildSupersededError` without writing while the abort does nothing. The newest rebuild
 * always wins, and a crashed one needs no timeout to be replaced. The checkpoint must only ever
 * grow, never reset when a rebuild finishes: a later rebuild could otherwise draw a number an
 * older one still holds and let that one write again. `generation` does not start with
 * `rebuild:`, so `pendingRebuilds` never mistakes it for progress.
 */
export const rebuildFencing: RebuildFencingFunction = (readModel) => ({
  lock: `rebuild:${readModel}`,
  generation: `rebuilding:${readModel}`,
});
