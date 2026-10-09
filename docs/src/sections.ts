import type { StarlightRouteData } from "@astrojs/starlight/route-data";

type Toc = StarlightRouteData["toc"];
type TocItem = NonNullable<Toc>["items"][number];

export interface SectionsOfFunction {
  (toc: Toc): readonly TocItem[];
}

// The page's sections for a table of contents: its headings without Starlight's "Overview" entry,
// which only points back at the title.
export const sectionsOf: SectionsOfFunction = (toc) =>
  (toc?.items ?? []).flatMap((item) => (item.slug === "_top" ? item.children : [item]));
