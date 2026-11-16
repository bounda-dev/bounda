import type { Witness } from "@bounda-dev/core";

/**
 * The witness of each Durable Object of a class, by the object's id.
 */
export interface ObjectWitnesses {
  of(id: string): Witness;
}

/**
 * Where `witnessObjects` keeps a class's witnesses. `Symbol.for`, so the Worker's copy of this
 * module and the test's find the same.
 */
export const OBJECT_WITNESSES: unique symbol = Symbol.for("@bounda-dev/cloudflare/witnesses");

export interface ObjectWitnessesOfFunction {
  (objectClass: object): ObjectWitnesses | undefined;
}

// A subclass reads its parent's, as statics are inherited.
export const objectWitnessesOf: ObjectWitnessesOfFunction = (objectClass) =>
  Reflect.get(objectClass, OBJECT_WITNESSES) as ObjectWitnesses | undefined;
