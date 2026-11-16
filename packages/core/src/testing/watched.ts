import type { Adapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import { type TestWitness, type WatchedApp, watchedBy } from "./witness.ts";

/**
 * What a target stands for: its witness, and the apps it watches that have not stopped.
 */
export interface Watched {
  readonly witness: TestWitness;
  readonly running: readonly WatchedApp[];
  readonly adapters: readonly Adapter[];
  readonly ledgers: readonly ForgetLedger[];
}

export interface WatchedOfFunction {
  (expectation: string, target: object): Watched | undefined;
}

/**
 * `undefined` for a target no witness stands behind. Throws when the witness has no app running:
 * an in-memory database is gone once its app stops, and a ledger closed.
 */
export const watchedOf: WatchedOfFunction = (expectation, target) => {
  const witness = watchedBy(target);
  if (witness === undefined) return undefined;
  if (witness.apps.length === 0) {
    throw new Error(
      `${expectation} found no app the witness watched: give the witness to createApp, boot() or createBounda as witness before the app starts`,
    );
  }
  const running = witness.apps.filter(({ stopped }) => !stopped);
  if (running.length === 0) {
    throw new Error(
      `${expectation} reads what the app keeps, so call it before app.stop(): an in-memory database is gone once the app stops`,
    );
  }
  return {
    witness,
    running,
    adapters: [...new Set(running.flatMap(({ adapters }) => adapters))],
    ledgers: running.flatMap(({ ledgers }) => ledgers),
  };
};
