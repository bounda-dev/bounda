// Reads the list on the European Commission's "Adequacy decisions" page by its wording and its
// list structure alone, never by class, id or attribute, which the site's templates change
// freely. Whatever it cannot place throws `UnreadablePageError`, so a page that changed shape
// fails the check rather than passing it with fewer entries.

export class UnreadablePageError extends Error {
  override readonly name = "UnreadablePageError";
}

export interface ReadAdequacyListFunction {
  (html: string): readonly string[];
}

// The rest of a tag, after its name: a quoted attribute value may hold a `>`.
const REST = `(?:"[^"]*"|'[^']*'|[^'">])*>`;
const TAG = `<(?=[a-z/!?])${REST}`;
const GAP = String.raw`(?:\s|&nbsp;|&#160;|&#xa0;|${TAG})+`;
const ANCHOR = `so${GAP}far${GAP}recogni[sz]ed`;
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["gt", ">"],
  ["hellip", "…"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["quot", '"'],
  ["rdquo", "”"],
  ["rsquo", "’"],
]);

const codePoint = (entity: string, code: number): string => {
  if (code > 0x10ffff) throw new UnreadablePageError(`it holds ${entity}, which is no character`);
  return String.fromCodePoint(code);
};

// An entity this cannot decode would make a name no one recognises, so it fails as unreadable.
const decode = (text: string): string =>
  text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (entity, decimal, hex, name) => {
    if (decimal !== undefined) return codePoint(entity, Number(decimal));
    if (hex !== undefined) return codePoint(entity, Number.parseInt(hex, 16));
    const character = NAMED_ENTITIES.get(name);
    if (character === undefined)
      throw new UnreadablePageError(`it holds ${entity}, an entity not decoded here`);
    return character;
  });

// Block tags part words; inline ones (links, emphasis) sit inside them.
const textOf = (html: string): string =>
  decode(
    html
      .replace(
        new RegExp(String.raw`<\/?(?:br|p|div|li|ul|ol|h[1-6]|table|tr|td|th)\b${REST}`, "gi"),
        " ",
      )
      .replace(new RegExp(TAG, "gi"), ""),
  )
    .replace(/\s+/g, " ")
    .trim();

// An entry as the list writes it, less the sentence around the list: "and the European Patent
// Organisation as providing adequate protection." is "European Patent Organisation".
const tidy = (text: string): string =>
  text
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/^and\s+/i, "")
    .replace(/^the\s+/i, "")
    .replace(/\s*as providing adequate protection[\s,.;]*$/i, "")
    .replace(/[\s,.;]+$/, "");

const listTag = (from: number): RegExp => {
  const tag = new RegExp(String.raw`<(\/?)(ul|ol)\b${REST}`, "gi");
  tag.lastIndex = from;
  return tag;
};

const listBody = (html: string, from: number): string => {
  const listTags = listTag(from);
  let depth = 0;
  let start = 0;
  for (let tag = listTags.exec(html); tag !== null; tag = listTags.exec(html)) {
    if (tag[1] === "") {
      if (depth === 0) start = tag.index + tag[0].length;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return html.slice(start, tag.index);
    }
  }
  throw new UnreadablePageError("the list of decisions never closes");
};

const insideTag = (page: string, index: number): boolean => {
  const tag = new RegExp(TAG, "gi");
  for (let match = tag.exec(page); match !== null && match.index < index; match = tag.exec(page)) {
    if (match.index + match[0].length > index) return true;
  }
  return false;
};

// The wording in the page's text, never inside a tag, as a meta description could repeat it.
const anchorIn = (page: string): RegExpExecArray | undefined => {
  const anchor = new RegExp(ANCHOR, "gi");
  for (let match = anchor.exec(page); match !== null; match = anchor.exec(page)) {
    if (!insideTag(page, match.index)) return match;
  }
  return undefined;
};

interface ListItems {
  readonly items: readonly string[];
  readonly outside: string;
}

// The list's own items, each with whatever it nests, and what the list holds outside them; a
// `<li>` may go unclosed, as HTML allows.
const itemsOf = (body: string): ListItems => {
  const items: string[] = [];
  let outside = "";
  const tag = new RegExp(String.raw`<(\/?)(li|ul|ol)\b${REST}`, "gi");
  let depth = 0;
  let start: number | undefined;
  let end = 0;
  for (let match = tag.exec(body); match !== null; match = tag.exec(body)) {
    const closing = match[1] === "/";
    if (match[2]?.toLowerCase() !== "li") {
      if (start === undefined) outside += body.slice(end, match.index);
      depth += closing ? -1 : 1;
      if (start === undefined) end = match.index + match[0].length;
    } else if (depth === 0) {
      if (start === undefined) outside += body.slice(end, match.index);
      else items.push(body.slice(start, match.index));
      start = closing ? undefined : match.index + match[0].length;
      end = match.index + match[0].length;
    }
  }
  if (start === undefined) outside += body.slice(end);
  else items.push(body.slice(start));
  return { items, outside };
};

// Between the wording and the list, nothing but punctuation, or the rest of a sentence that
// introduces the list: "has so far recognised the following:".
const introducesList = (text: string): boolean =>
  /^[\s:.,;–—-]*$/.test(text) || /^[^.!?]*:$/.test(text);

export const readAdequacyList: ReadAdequacyListFunction = (html) => {
  const page = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  const anchor = anchorIn(page);
  if (anchor === undefined) {
    throw new UnreadablePageError(
      'it no longer says which countries the Commission "has so far recognised"',
    );
  }
  const after = anchor.index + anchor[0].length;
  const open = listTag(after).exec(page);
  if (open === null || open[1] === "/" || !introducesList(textOf(page.slice(after, open.index)))) {
    throw new UnreadablePageError('no list follows "has so far recognised"');
  }
  const { items, outside } = itemsOf(listBody(page, open.index));
  const stray = textOf(outside);
  if (/[^\s,.;]/.test(stray)) {
    throw new UnreadablePageError(`the list holds "${stray}" outside its items`);
  }
  const entries = items.map((item) => tidy(textOf(item)));
  if (entries.length === 0) throw new UnreadablePageError("the list of decisions is empty");
  if (entries.includes("")) throw new UnreadablePageError("the list has an empty entry");
  return entries;
};
