import type { Witness } from "@bounda-dev/core";
import { createWitness } from "@bounda-dev/core/testing";
import type { BoundaObjectClass } from "./bounda-object.ts";
import { WITNESS } from "./witnesses.ts";

export interface WitnessObjectsOptions {
  /**
   * What serves requests in front of the objects and logs beside them: the Worker `createWorker`
   * returns, or what `createBounda` from `@bounda-dev/react-router/cloudflare` returns. What each
   * logs is searched with every object's persons.
   */
  readonly hosts?: readonly object[];
}

export interface WitnessObjectsFunction {
  (objectClass: BoundaObjectClass, options?: WitnessObjectsOptions): Witness;
}

/**
 * For tests in `workerd`: gives the Durable Objects of the class `createBoundaObject` returned, or
 * of a class extending it, opened from now on, a witness, as `createWitness` makes one, which
 * records what each object's app seals, keeps, logs and traces, what the object logs itself, and
 * what `hosts` log; each object's persons are kept apart, as each object is a tenant of its own.
 * Inside the object, with `runInDurableObject`, `expectForgotten`, `expectRedacted` and
 * `expectTenantForgotten` then take the object and search its SQLite, the forget ledger its app
 * opened, KV included, its logs, the hosts' and its spans. Call it at the top of the test file,
 * before any object of the class opens: one opened before has no witness, and the expectations
 * refuse it as they refuse any object without one. Returns the class's witness, the same however
 * often it is called, the hosts given each time added.
 */
export const witnessObjects: WitnessObjectsFunction = (objectClass, { hosts = [] } = {}) => {
  const known = Object.hasOwn(objectClass, WITNESS)
    ? (Reflect.get(objectClass, WITNESS) as Witness)
    : undefined;
  const witness = known ?? createWitness();
  // Defining the same value again is allowed, as the class's own stays.
  Object.defineProperty(objectClass, WITNESS, { value: witness });
  for (const host of hosts) {
    Object.defineProperty(host, WITNESS, { value: witness, configurable: true });
  }
  return witness;
};
