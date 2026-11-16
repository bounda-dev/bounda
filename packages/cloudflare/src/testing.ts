import type { Witness } from "@bounda-dev/core";
import { createWitness } from "@bounda-dev/core/testing";
import type { BoundaObjectClass } from "./bounda-object.ts";
import { OBJECT_WITNESSES, type ObjectWitnesses } from "./witnesses.ts";

export interface WitnessObjectsFunction {
  (objectClass: BoundaObjectClass): void;
}

/**
 * For tests in `workerd`: gives every Durable Object of the class `createBoundaObject` returned,
 * or of a class extending it, opened from now on, a witness of its own, as `createWitness` makes
 * one, which records what its app seals, keeps, logs and traces, and what the object logs itself.
 * Inside the object, with `runInDurableObject`, `expectForgotten`, `expectRedacted` and
 * `expectTenantForgotten` then take the object and search its SQLite, the forget ledger its app
 * opened, KV included, its logs and its spans. Call it at the top of the test file, before any
 * object of the class opens: one opened before has no witness, and the expectations refuse it as
 * they refuse any object without one. Calling it again changes nothing.
 */
export const witnessObjects: WitnessObjectsFunction = (objectClass) => {
  if (Object.hasOwn(objectClass, OBJECT_WITNESSES)) return;
  // One per object: an object opened again, after eviction or once its storage is discarded,
  // adds to what its earlier app saw.
  const witnesses = new Map<string, Witness>();
  const of: ObjectWitnesses["of"] = (id) => {
    const known = witnesses.get(id);
    if (known !== undefined) return known;
    const created = createWitness();
    witnesses.set(id, created);
    return created;
  };
  Object.defineProperty(objectClass, OBJECT_WITNESSES, { value: { of } satisfies ObjectWitnesses });
};
