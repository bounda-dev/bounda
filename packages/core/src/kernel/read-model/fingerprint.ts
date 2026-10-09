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

export const readModelSource: ReadModelSourceFunction = (entry) =>
  [
    String(entry.view.fields),
    ...Object.entries(entry.projections)
      .flatMap(([aggregate, projections]) =>
        Object.entries(projections).map(
          ([key, projection]) => [`${aggregate}.${key}`, projection] as const,
        ),
      )
      // By code unit: a locale-aware order would change the fingerprint from one machine to another.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([name, projection]) =>
          `${name}|${String(projection.on ?? "")}|${String(projection.project)}`,
      ),
  ].join("\n");

export interface FingerprintReadModelFunction {
  (entry: ReadModelEntry): string;
}

/**
 * A rebuild paused under one fingerprint resumes only under the same one, so a deploy in the
 * middle of a rebuild starts it again instead of mixing rows projected by two versions of the
 * code. Only the text of the view's and projections' own functions counts, not what they import:
 * a change to an imported helper alone resumes the rebuild. A change of formatting alone changes
 * it, which only costs a restarted rebuild.
 */
export const fingerprintReadModel: FingerprintReadModelFunction = (entry) =>
  digest(readModelSource(entry));
