/**
 * A table of an adapter's database, or what an in-memory store keeps as one, as
 * `Adapter.inspect` reads it: every row as stored, nothing opened.
 */
export interface InspectedTable {
  readonly name: string;
  /**
   * The columns that tell its rows apart, so a report can name the row.
   */
  readonly key: readonly string[];
  /**
   * The columns that hold only key material, which is random text: a search compares their values
   * whole and never looks inside them, where a short value would turn up by chance.
   */
  readonly opaque: readonly string[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
}
