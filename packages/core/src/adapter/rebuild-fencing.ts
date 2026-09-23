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
 * Every later step, a batch, the commit or the abort, takes `lock` again and goes ahead only while
 * the checkpoint still holds that value; otherwise another rebuild has taken over and the step
 * throws `RebuildSupersededError` without writing. The newest rebuild always wins, and a crashed
 * one needs no timeout to be replaced. The checkpoint only ever grows, and outlives the rebuilds
 * it counted: were it reset when one finished, a later rebuild could draw a number an older one
 * still holds and let that one write again. `generation` does not start with `rebuild:`, so
 * `pendingRebuilds` never mistakes it for progress.
 */
export const rebuildFencing: RebuildFencingFunction = (readModel) => ({
  lock: `rebuild:${readModel}`,
  generation: `rebuilding:${readModel}`,
});
