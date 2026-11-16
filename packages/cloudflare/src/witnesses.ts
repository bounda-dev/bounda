import type { Logger, Witness } from "@bounda-dev/core";

/**
 * Where `witnessObjects` keeps the witness of a class of objects, and of each host beside them.
 * `Symbol.for`, so the Worker's copy of this module and the test's find the same.
 */
export const WITNESS: unique symbol = Symbol.for("@bounda-dev/cloudflare/witness");

export interface WitnessOfFunction {
  (target: object): Witness | undefined;
}

// A subclass reads its parent's, as statics are inherited.
export const witnessOf: WitnessOfFunction = (target) =>
  Reflect.get(target, WITNESS) as Witness | undefined;

export interface HostLoggerFunction {
  (host: object, logger: Logger): Logger;
}

/**
 * The logger `host`, such as the Worker `createWorker` returns, logs through: `logger`, through
 * the witness `witnessObjects` gave the host when a test did, so what it logs is searched beside
 * what the objects keep. Read on every call, since the test gives it once the host exists.
 */
export const hostLogger: HostLoggerFunction = (host, logger) =>
  witnessOf(host)?.logger(logger) ?? logger;
