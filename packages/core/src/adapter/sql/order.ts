export interface CodePointOrderFunction {
  (a: string, b: string): number;
}

// UTF-16 puts a surrogate (U+D800–U+DFFF) before U+E000–U+FFFF, but the character above U+FFFF it
// encodes comes after them in UTF-8, whose bytes SQLite's BINARY and PostgreSQL's "C" compare.
const lift = (unit: number): number =>
  unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;

export const codePointOrder: CodePointOrderFunction = (a, b) => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const x = a.charCodeAt(index);
    const y = b.charCodeAt(index);
    if (x !== y) return lift(x) - lift(y);
  }
  return a.length - b.length;
};
