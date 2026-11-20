export interface InWorkerRuntimeFunction {
  (): boolean;
}

// workerd names itself so, under `wrangler dev` and the tests as when deployed; Node, where a
// terminal loads the configuration, names itself otherwise.
export const inWorkerRuntime: InWorkerRuntimeFunction = () =>
  globalThis.navigator?.userAgent === "Cloudflare-Workers";

// What to do instead of opening a store from a terminal, which has no Durable Object or KV binding.
export const ROTATE_IN_WORKER =
  "each tenant's key is rewrapped in its own Durable Object, which the scheduled handler of createWorker wakes: give the Worker a cron trigger instead of running this from a terminal";
export const LEDGER_IN_OBJECT =
  "each tenant's Bounda Durable Object reads and writes its ledger, and its tenant export hands the entries out";
