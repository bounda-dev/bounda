import { type Adapter, isAdapter } from "../adapter/adapter.ts";
import type { ForgetLedger } from "../adapter/storage/forget-ledger.ts";
import type { PersonData } from "./person-data.ts";
import { type LoggedEntry, type Traced, type WatchedApp, watchedBy } from "./witness.ts";

/**
 * One tenant's share of what an expectation searches: its apps that run, the tables they opened,
 * what they were seen doing with its persons' data, their logs and spans. A tenant's persons are
 * looked for in its own tables alone, as the same id names another person in another tenant.
 */
export interface Scope {
  /**
   * `null` for an adapter given in place of an app, of which nothing was seen.
   */
  readonly data: PersonData | null;
  readonly running: readonly WatchedApp[];
  readonly adapters: readonly Adapter[];
  readonly ledgers: readonly ForgetLedger[];
  readonly logs: readonly LoggedEntry[];
  readonly traces: readonly Traced[];
}

export interface ScopesOfFunction {
  (expectation: string, target: unknown): readonly Scope[];
}

/**
 * What `target` stands for, one scope for each tenant it covers that has an app running. Throws a
 * `TypeError` for what is neither watched nor an adapter, and an `Error` when no app it stands for
 * has started, or every one has stopped: an in-memory database is gone then, and a ledger closed.
 */
export const scopesOf: ScopesOfFunction = (expectation, target) => {
  const watched = typeof target === "object" && target !== null ? watchedBy(target) : undefined;
  if (watched === undefined) {
    if (!isAdapter(target)) {
      throw new TypeError(
        `${expectation} takes an app createTestApp returned or one given a witness, a client of one, a witness, a Durable Object of a class witnessObjects watches, or an adapter: for an app built without a witness, pass its storage adapter with the values to look for`,
      );
    }
    return [{ data: null, running: [], adapters: [target], ledgers: [], logs: [], traces: [] }];
  }
  const { witness, tenant } = watched;
  const apps = witness.apps.filter((app) => tenant === null || app.tenant === tenant);
  if (apps.length === 0) {
    throw new Error(
      `${expectation} found no app the witness watched that started: give it the witness before it starts, as createApp, boot() and createBounda take it, and check that it started`,
    );
  }
  const running = apps.filter(({ stopped }) => !stopped);
  if (running.length === 0) {
    throw new Error(
      `${expectation} reads what the app keeps, so call it before app.stop(): an in-memory database is gone once the app stops`,
    );
  }
  return [...new Set(running.map((app) => app.tenant))].map((each) => {
    const own = running.filter((app) => app.tenant === each);
    return {
      data: witness.of(each),
      running: own,
      adapters: [...new Set(own.flatMap(({ adapters }) => adapters))],
      ledgers: own.flatMap(({ ledgers }) => ledgers),
      logs: witness.logs.filter((entry) => entry.tenant === null || entry.tenant === each),
      traces: witness.traces.filter((traced) => traced.tenant === each),
    };
  });
};
