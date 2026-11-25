export interface CanonicalSqlFunction {
  (sql: string): string;
}

// Opening a list, or a separator: no space is needed after them, nor before what closes or
// separates.
const AFTER = new Set(["(", ","]);
const BEFORE = new Set(["(", ")", ","]);

/**
 * `sql` with the whitespace a statement means nothing by taken out: every run outside a quoted
 * name or string becomes one space, and none is kept beside a parenthesis or a comma. SQLite keeps
 * a table's definition as text, and a column added later sits in it spaced as `ALTER TABLE` wrote
 * it, so two tables of the same shape compare by this.
 */
export const canonicalSql: CanonicalSqlFunction = (sql) => {
  let text = "";
  let quote: string | undefined;
  let spaced = false;
  for (const character of sql) {
    if (quote !== undefined) {
      text += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (/\s/.test(character)) {
      spaced = true;
      continue;
    }
    const previous = text.at(-1);
    if (spaced && previous !== undefined && !AFTER.has(previous) && !BEFORE.has(character)) {
      text += " ";
    }
    spaced = false;
    if (character === "'" || character === '"') quote = character;
    text += character;
  }
  return text;
};
