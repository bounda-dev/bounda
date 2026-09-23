import type { ReadModelEntry } from "../../modules/registry.ts";

export interface DigestFunction {
  (text: string): string;
}

const fnv1a = (text: string, basis: number): number => {
  let value = basis;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

/**
 * Sixteen hex digits: FNV-1a over the text from two offset bases.
 */
export const digest: DigestFunction = (text) =>
  [fnv1a(text, 0x811c9dc5), fnv1a(text, 0x050c5d1f)]
    .map((part) => part.toString(16).padStart(8, "0"))
    .join("");

export interface ReadModelSourceFunction {
  (entry: ReadModelEntry): string;
}

/**
 * The code that shapes a read model's rows, as text: its fields, then every projection by name
 * with the events it listens to.
 */
export const readModelSource: ReadModelSourceFunction = (entry) =>
  [
    String(entry.view.fields),
    ...Object.entries(entry.projections)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, projection]) =>
          `${key}|${String(projection.on ?? "")}|${String(projection.project)}`,
      ),
  ].join("\n");

export interface FingerprintReadModelFunction {
  (entry: ReadModelEntry): string;
}

/**
 * A short digest of a read model's fields and projections. A rebuild paused under one fingerprint
 * is only resumed under the same one, so a deploy in the middle of a rebuild starts it again
 * instead of mixing rows projected by two versions of the code. Code that changes only its
 * formatting changes the fingerprint too, which costs a restarted rebuild and nothing else.
 */
export const fingerprintReadModel: FingerprintReadModelFunction = (entry) =>
  digest(readModelSource(entry));
