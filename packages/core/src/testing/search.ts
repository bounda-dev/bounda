/**
 * Below this length a value is matched as a whole word, never inside a longer one: `Ana` inside
 * `Banana` or `metadata` is a coincidence, not her name.
 */
export const MIN_SUBSTRING_LENGTH = 6;

export interface Needle {
  readonly value: string;
  readonly lower: string;
  readonly word: RegExp | null;
}

export interface NeedlesOfArgs {
  readonly values: readonly unknown[];
  /**
   * Never searched: ids stay by design, so a value equal to the person's id is everywhere.
   */
  readonly personId: string;
}

export interface NeedlesOfFunction {
  (args: NeedlesOfArgs): readonly Needle[];
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const leavesOf = (value: unknown, into: string[]): void => {
  if (typeof value === "string") into.push(value);
  else if (typeof value === "number" || typeof value === "bigint") into.push(String(value));
  else if (Array.isArray(value)) for (const item of value) leavesOf(item, into);
  else if (typeof value === "object" && value !== null && !(value instanceof Date)) {
    for (const item of Object.values(value)) leavesOf(item, into);
  } else if (value instanceof Date) into.push(value.toISOString());
};

/**
 * The texts to look for: every string and number in `values`, however deep, once each whatever
 * its case. Object keys are a schema's, not a person's, so only values count.
 */
export const needlesOf: NeedlesOfFunction = ({ values, personId }) => {
  const leaves: string[] = [];
  for (const value of values) leavesOf(value, leaves);
  const byLower = new Map<string, Needle>();
  for (const value of leaves) {
    const lower = value.toLowerCase();
    if (lower.trim() === "" || lower === personId.toLowerCase() || byLower.has(lower)) continue;
    byLower.set(lower, {
      value,
      lower,
      word:
        value.length < MIN_SUBSTRING_LENGTH
          ? new RegExp(`(?<![\\p{L}\\p{N}])${literal(value)}(?![\\p{L}\\p{N}])`, "iu")
          : null,
    });
  }
  return [...byLower.values()];
};

/**
 * A text found somewhere, with the path to it from where the search began.
 */
export interface Leaf {
  readonly path: readonly string[];
  readonly text: string;
  readonly lower: string;
  /**
   * Key material or ciphertext: compared whole, never searched inside.
   */
  readonly opaque: boolean;
}

// What a sealed value holds besides the person's id: a fingerprint, a nonce and the ciphertext.
const ENVELOPE_OPAQUE = new Set(["key", "iv", "data"]);
const OPAQUE_NAMES = new Set(["fingerprint", "fingerprints"]);

const decoder = new TextDecoder();

const isEnvelope = (value: Record<string, unknown>): boolean => {
  const envelope: unknown = value.$personal;
  return typeof envelope === "object" && envelope !== null && !Array.isArray(envelope);
};

const parsedJson = (text: string): unknown => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const walk = (
  value: unknown,
  path: readonly string[],
  opaque: boolean,
  into: Leaf[],
  seen: WeakSet<object>,
): void => {
  if (value === null || value === undefined || typeof value === "boolean") return;
  if (typeof value === "string") {
    const parsed = opaque ? undefined : parsedJson(value);
    if (parsed === undefined) into.push({ path, text: value, lower: value.toLowerCase(), opaque });
    else walk(parsed, path, opaque, into, seen);
    return;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const text = String(value);
    into.push({ path, text, lower: text, opaque });
    return;
  }
  if (typeof value !== "object") return;
  if (value instanceof Date) {
    const text = Number.isNaN(value.getTime()) ? "" : value.toISOString();
    into.push({ path, text, lower: text.toLowerCase(), opaque });
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    walk(decoder.decode(bytes), path, opaque, into, seen);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walk(item, [...path, `[${index}]`], opaque, into, seen);
    });
    return;
  }
  const record = value as Record<string, unknown>;
  if (isEnvelope(record)) {
    const envelope = record.$personal as Record<string, unknown>;
    for (const [field, inner] of Object.entries(envelope)) {
      walk(inner, [...path, "$personal", field], opaque || ENVELOPE_OPAQUE.has(field), into, seen);
    }
    return;
  }
  for (const [field, inner] of Object.entries(record)) {
    into.push({ path: [...path, field], text: field, lower: field.toLowerCase(), opaque });
    walk(inner, [...path, field], opaque || OPAQUE_NAMES.has(field), into, seen);
  }
};

export interface LeavesInFunction {
  (value: unknown, opaque?: boolean): readonly Leaf[];
}

/**
 * Every text in `value`, however deep, a JSON document held as text included. An object's keys
 * are texts too, since a map may be keyed by a person's value.
 */
export const leavesIn: LeavesInFunction = (value, opaque = false) => {
  const into: Leaf[] = [];
  walk(value, [], opaque, into, new WeakSet());
  return into;
};

export interface MatchesFunction {
  (needle: Needle, leaf: Leaf): boolean;
}

export const matches: MatchesFunction = (needle, { text, lower, opaque }) => {
  if (opaque) return lower === needle.lower;
  if (needle.word !== null) return needle.word.test(text);
  return lower.includes(needle.lower);
};
