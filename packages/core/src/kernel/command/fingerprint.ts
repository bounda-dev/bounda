export interface FingerprintArgs {
  readonly type: string;
  readonly payload: unknown;
}

export interface FingerprintFunction {
  (args: FingerprintArgs): Promise<string>;
}

// JSON with the keys of every object in order, so two payloads that are the same object
// written in another order fingerprint alike.
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
};

/**
 * What identifies a command under an idempotency key: the SHA-256 of its type and payload, as
 * JSON, in hex. `undefined` and a missing payload fingerprint alike, as JSON cannot tell them
 * apart either.
 */
export const fingerprintOf: FingerprintFunction = async ({ type, payload }) => {
  const bytes = new TextEncoder().encode(JSON.stringify([type, canonical(payload) ?? null]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
