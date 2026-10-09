// The sidebar's groups, one per directory of `src/content/docs`. The social cards name a page's
// group from here, and `@bounda-dev/core`'s docs pack keeps its own list equal to this one.
export const SIDEBAR = [
  { label: "Getting started", items: [{ autogenerate: { directory: "getting-started" } }] },
  { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
  { label: "Examples", items: [{ autogenerate: { directory: "examples" } }] },
  { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
  { label: "Adapters", items: [{ autogenerate: { directory: "adapters" } }] },
  { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
];
