import type { StarlightRouteData } from "@astrojs/starlight/route-data";

type SidebarEntry = StarlightRouteData["sidebar"][number];
type SidebarLink = Extract<SidebarEntry, { type: "link" }>;

export interface Position {
  readonly link: SidebarLink;
  readonly group: string;
  readonly number: string;
}

export interface PositionsOfFunction {
  (sidebar: readonly SidebarEntry[]): readonly Position[];
}

const linksOf = (entries: readonly SidebarEntry[]): readonly SidebarEntry[] =>
  entries.flatMap((entry) => (entry.type === "group" ? linksOf(entry.entries) : [entry]));

// A page's place in the docs, as the ledger writes a position: its sidebar group and its number
// within it, in the order the sidebar lists it.
export const positionsOf: PositionsOfFunction = (sidebar) =>
  sidebar.flatMap((group) =>
    group.type === "group"
      ? linksOf(group.entries).flatMap((link, index) =>
          link.type === "link"
            ? [
                {
                  link,
                  group: group.label,
                  number: String(index + 1).padStart(2, "0"),
                },
              ]
            : [],
        )
      : [],
  );
