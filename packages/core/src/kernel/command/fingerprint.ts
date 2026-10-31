export interface FingerprintArgs {
  readonly type: string;
  readonly payload: unknown;
  // Scheduled dispatches only: what `delay` came to, so a scheduled command and an immediate one
  // never share a key.
  readonly delayMs?: number | undefined;
}

export interface FingerprintFunction {
  (args: FingerprintArgs): Promise<string>;
}

// JSON with the keys of every object in order, so two payloads that are the same object
// written in another order fingerprint alike. What JSON cannot write, a `Map`, a `Set` or a
// `bigint`, goes in tagged, so payloads that differ there never fingerprint alike.
const canonical = (value: unknown): unknown => {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value;
  // Each entry as JSON, sorted by code unit, so the order they were added in does not count.
  if (value instanceof Map) {
    return {
      $map: [...value]
        .map(([key, entry]) => JSON.stringify([canonical(key), canonical(entry)]))
        .sort(),
    };
  }
  if (value instanceof Set) {
    return { $set: [...value].map((member) => JSON.stringify([canonical(member)])).sort() };
  }
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
};

/**
 * What identifies a command under an idempotency key: the SHA-256 of its type, its payload and
 * its delay, if any, as JSON, in hex. `undefined` and a missing payload fingerprint alike, as JSON
 * cannot tell them apart either.
 */
export const fingerprintOf: FingerprintFunction = async ({ type, payload, delayMs }) => {
  const identity = [type, canonical(payload) ?? null];
  if (delayMs !== undefined) identity.push({ delayMs });
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
