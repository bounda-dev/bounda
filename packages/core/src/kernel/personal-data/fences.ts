import type { KeyedPerson } from "../../adapter/storage/personal-key-store.ts";

// The head of the stream just before the read that opened each person's data, for an app whose
// ports tell recipients: what the person's own stream wrote past it, a forgetting, a restriction
// or a redaction, the read may not reflect.
const fences = new WeakMap<KeyedPerson, number>();

export interface StampFenceFunction {
  (persons: Iterable<KeyedPerson>, position: number): void;
}

/**
 * Records that `persons` were read with the stream at `position` or later.
 */
export const stampFence: StampFenceFunction = (persons, position) => {
  for (const held of persons) fences.set(held, Math.min(fences.get(held) ?? position, position));
};

export interface FenceOfFunction {
  (held: KeyedPerson): number | undefined;
}

/**
 * The head of the stream before `held` was read, `undefined` for a read no fence was taken for.
 */
export const fenceOf: FenceOfFunction = (held) => fences.get(held);
