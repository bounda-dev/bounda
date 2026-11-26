import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAdequacyList, UnreadablePageError } from "./page.ts";

// The section of the Commission's page that holds the list, as served on 26 November 2026.
const page = readFileSync(new URL("fixtures/adequacy-decisions.html", import.meta.url), "utf8");

const listed = [
  "Andorra",
  "Argentina",
  "Brazil",
  "Canada (commercial organisations)",
  "Faroe Islands",
  "Guernsey",
  "Israel",
  "Isle of Man",
  "Japan",
  "Jersey",
  "New Zealand",
  "Republic of Korea",
  "Switzerland",
  "United Kingdom under the GDPR and the LED, as amended in December 2025 through one renewal decision under the GDPR and one renewal decision under the LED",
  "United States (commercial organisations participating in the EU-US Data Privacy Framework)",
  "Uruguay",
  "European Patent Organisation",
];

const unreadable = (html: string): string => {
  try {
    readAdequacyList(html);
  } catch (error) {
    if (error instanceof UnreadablePageError) return error.message;
    throw error;
  }
  throw new Error("the page was read");
};

describe("readAdequacyList", () => {
  it("reads every entry of the Commission's page, in its order", () => {
    expect(readAdequacyList(page)).toEqual(listed);
  });

  it("reads the list whatever its classes, attributes and case", () => {
    const bare = page
      .replace(/\s(?:class|href|id|data-[\w-]+)="[^"]*"/g, "")
      .replace(
        /<(\/?)(ul|li)>/g,
        (_, slash: string, tag: string) => `<${slash}${tag.toUpperCase()}>`,
      );
    expect(readAdequacyList(bare)).toEqual(listed);
  });

  it("reads an ordered list, and items left unclosed", () => {
    expect(
      readAdequacyList(
        "<p>The Commission has so far recognised:</p><ol><li>Andorra,<li>Japan<li>and Uruguay as providing adequate protection.</ol>",
      ),
    ).toEqual(["Andorra", "Japan", "Uruguay"]);
  });

  it("keeps what an item nests in that item", () => {
    expect(
      readAdequacyList(
        "<p>so far recognised:</p><ul><li>Canada<ul><li>commercial</li><li>public</li></ul></li><li>Japan</li></ul>",
      ),
    ).toEqual(["Canada commercial public", "Japan"]);
  });

  it("finds the wording across tags, spaces and either spelling", () => {
    expect(
      readAdequacyList(
        "<p>has <strong>so</strong>&nbsp;far\n recognized</p>\n<ul>\n<li>Japan</li>\n</ul>",
      ),
    ).toEqual(["Japan"]);
  });

  it("decodes entities and spacing around punctuation", () => {
    expect(
      readAdequacyList(
        "so far recognised:<ul><li>Cura&#231;ao&#xA0;( territory ) ,</li><li>C&#244;te d&rsquo;Ivoire</li><li>Tom &amp; Jerry &lt;&gt; &quot;x&quot; &apos;</li></ul>",
      ),
    ).toEqual(["Curaçao (territory)", "Côte d’Ivoire", 'Tom & Jerry <> "x" \'']);
  });

  it("ignores the wording in comments, scripts and styles", () => {
    expect(
      readAdequacyList(
        "<!-- so far recognised: <ul><li>Mars</li></ul> --><script>'so far recognised'</script><style>p{}</style><p>so far recognised:</p><ul><li>Japan</li></ul>",
      ),
    ).toEqual(["Japan"]);
  });

  it("reads a list the wording's sentence introduces", () => {
    expect(
      readAdequacyList(
        "<p>has so far recognised the following countries:</p><ul><li>Japan</li></ul>",
      ),
    ).toEqual(["Japan"]);
  });

  it("refuses a list that holds text outside its items", () => {
    expect(unreadable("so far recognised:<ul>Andorra<li>Japan</li></ul>")).toBe(
      'the list holds "Andorra" outside its items',
    );
    expect(unreadable("so far recognised:<ul><li>Japan</li> , Israel</ul>")).toBe(
      'the list holds ", Israel" outside its items',
    );
    expect(unreadable("so far recognised:<ul><li>Japan</li><ul><li>Israel</li></ul></ul>")).toBe(
      'the list holds "Israel" outside its items',
    );
  });

  it("finds the wording in the text only, never in the head or inside a tag", () => {
    expect(
      readAdequacyList(
        '<html><head><title>so far recognised</title><meta content="has so far recognised:"></head><body><nav><ul><li>Home</li></ul></nav><p data-x="so far recognised"><abbr title="a > b, so far recognised">EU</abbr> has so far recognised:</p><ul><li>Japan</li></ul></body></html>',
      ),
    ).toEqual(["Japan"]);
  });

  it("reads tags whose quoted attributes hold a >, and a < in text", () => {
    expect(
      readAdequacyList(
        'so far recognised:<ul data-x=\'a>b\'><li data-tip="a > b">Japan <a title="x>y">(1 < 2)</a></li></ul>',
      ),
    ).toEqual(["Japan (1 < 2)"]);
  });

  it("refuses a page that no longer has the wording", () => {
    expect(unreadable("<p>The Commission recognises:</p><ul><li>Japan</li></ul>")).toBe(
      'it no longer says which countries the Commission "has so far recognised"',
    );
  });

  it("refuses a list that does not follow the wording at once", () => {
    expect(
      unreadable("<p>so far recognised the following.</p><p>More</p><ul><li>x</li></ul>"),
    ).toBe('no list follows "has so far recognised"');
    expect(unreadable("<p>so far recognised Andorra. They are:</p><ul><li>x</li></ul>")).toBe(
      'no list follows "has so far recognised"',
    );
    expect(unreadable("<p>so far recognised Andorra, Japan.</p>")).toBe(
      'no list follows "has so far recognised"',
    );
    expect(unreadable("<ul><li>so far recognised</li></ul><ul><li>x</li></ul>")).toBe(
      'no list follows "has so far recognised"',
    );
  });

  it("refuses a list that never closes", () => {
    expect(unreadable("so far recognised:<ul><li>Japan<ul><li>x</li></ul>")).toBe(
      "the list of decisions never closes",
    );
  });

  it("refuses an entity it cannot decode", () => {
    expect(unreadable("so far recognised:<ul><li>C&ocirc;te d'Ivoire</li></ul>")).toBe(
      "it holds &ocirc;, an entity not decoded here",
    );
    expect(unreadable("so far recognised:<ul><li>&constructor;Japan</li></ul>")).toBe(
      "it holds &constructor;, an entity not decoded here",
    );
    expect(unreadable("so far recognised:<ul><li>&NBSP;Japan</li></ul>")).toBe(
      "it holds &NBSP;, an entity not decoded here",
    );
    expect(unreadable("so far recognised:<ul><li>&#x110000;</li></ul>")).toBe(
      "it holds &#x110000;, which is no character",
    );
  });

  it("refuses an empty list or an empty entry", () => {
    expect(unreadable("so far recognised:<ul> </ul>")).toBe("the list of decisions is empty");
    expect(unreadable("so far recognised:<ul><li>Japan</li><li> , </li></ul>")).toBe(
      "the list has an empty entry",
    );
  });
});
