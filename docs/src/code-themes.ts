// Expressive Code themes built from the design system's tokens, one per mode: keywords and numbers
// in the accent's text colour, strings in verdigris, types in stone, comments muted.

interface Palette {
  readonly type: "dark" | "light";
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly rule: string;
  readonly keyword: string;
  readonly string: string;
  readonly typeName: string;
  readonly selection: string;
}

const theme = (name: string, p: Palette) => ({
  name,
  type: p.type,
  colors: {
    "editor.background": p.background,
    "editor.foreground": p.text,
    "editor.selectionBackground": p.selection,
    "editorGroupHeader.tabsBackground": p.background,
    "tab.activeBackground": p.background,
    "tab.activeForeground": p.text,
    "tab.inactiveForeground": p.muted,
    "tab.border": p.rule,
    "titleBar.activeBackground": p.background,
    "titleBar.activeForeground": p.muted,
    "titleBar.border": p.rule,
    "terminal.background": p.background,
    "terminal.foreground": p.text,
    "panel.border": p.rule,
    focusBorder: p.keyword,
  },
  tokenColors: [
    { settings: { foreground: p.text } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: p.muted } },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "keyword.operator.new",
        "keyword.operator.expression",
        "constant.language",
        "constant.numeric",
      ],
      settings: { foreground: p.keyword },
    },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: p.text } },
    {
      scope: [
        "string",
        "string.template",
        "punctuation.definition.string",
        "punctuation.definition.template-expression",
        "markup.inline.raw",
      ],
      settings: { foreground: p.string },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
      ],
      settings: { foreground: p.typeName },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: p.text, fontStyle: "bold" },
    },
    {
      scope: ["entity.name.tag", "support.type.property-name"],
      settings: { foreground: p.keyword },
    },
  ],
});

export const basalt = theme("bounda-basalt", {
  type: "dark",
  background: "#1b1c1e",
  text: "#e6e0d3",
  muted: "#9c978c",
  rule: "#2e2f32",
  keyword: "#d9a04a",
  string: "#8fc2b0",
  typeName: "#b9b4a7",
  selection: "#3a2f1c",
});

export const bone = theme("bounda-bone", {
  type: "light",
  background: "#f7f6f2",
  text: "#1a1916",
  muted: "#5f5b53",
  rule: "#d3cfc5",
  keyword: "#8a5508",
  string: "#4f6b5e",
  typeName: "#4a4e57",
  selection: "#eadfc9",
});
