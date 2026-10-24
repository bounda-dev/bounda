import { parse, stringify } from "devalue";
import { isRecord } from "../shared/merge-fields.ts";
import type { FoldedState } from "./fold-state.ts";

export interface SerializeFoldFunction {
  (folded: FoldedState): string;
}

/**
 * Keeps what JSON loses: `Date`, `Map`, `Set`, `bigint`, `undefined` and the rest devalue
 * handles. Throws for what cannot be kept, a class instance or a function.
 */
export const serializeFold: SerializeFoldFunction = (folded) => stringify(folded);

export interface DeserializeFoldFunction {
  (text: string): FoldedState;
}

/**
 * Throws for text `serializeFold` did not produce.
 */
export const deserializeFold: DeserializeFoldFunction = (text) => {
  const value: unknown = parse(text);
  if (
    !isRecord(value) ||
    !isRecord(value.state) ||
    typeof value.created !== "boolean" ||
    (value.openedWithout !== null && typeof value.openedWithout !== "string")
  ) {
    throw new TypeError("not a serialized fold");
  }
  return { state: value.state, created: value.created, openedWithout: value.openedWithout };
};

const sameEntries = (left: Map<unknown, unknown>, right: Map<unknown, unknown>): boolean =>
  left.size === right.size &&
  [...left].every(([key, value]) => right.has(key) && equal(value, right.get(key)));

const sameMembers = (left: Set<unknown>, right: Set<unknown>): boolean =>
  left.size === right.size &&
  [...left].every(
    (member) => right.has(member) || [...right].some((other) => equal(member, other)),
  );

const sameFields = (left: object, right: object): boolean => {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
};

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())
    );
  }
  if (left instanceof Map || right instanceof Map) {
    return left instanceof Map && right instanceof Map && sameEntries(left, right);
  }
  if (left instanceof Set || right instanceof Set) {
    return left instanceof Set && right instanceof Set && sameMembers(left, right);
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  return sameFields(left, right);
};

export interface FoldsEqualFunction {
  (left: FoldedState, right: FoldedState): boolean;
}

/**
 * Structural, so the order fields were set in does not count.
 */
export const foldsEqual: FoldsEqualFunction = (left, right) =>
  left.created === right.created &&
  left.openedWithout === right.openedWithout &&
  equal(left.state, right.state);
