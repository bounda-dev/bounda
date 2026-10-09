import { getCollection } from "astro:content";
import type { GetStaticPaths } from "astro";
import { SIDEBAR } from "../../sidebar.ts";
import { SITE } from "../../site.ts";
import { socialCard } from "../../social-card.ts";

// One card per page at /og/<page id>.png; route-data.ts points each page's og:image here.
export const getStaticPaths = (async () => {
  const pages = await getCollection("docs");
  const groupOf = (id: string) => id.split("/")[0] ?? "";
  // The sidebar orders a group by `sidebar.order`, and every page sets one.
  const order = (entry: (typeof pages)[number]) => entry.data.sidebar.order ?? 0;
  return pages.map((entry) => {
    const group = SIDEBAR.find(
      ({ items }) => items[0]?.autogenerate.directory === groupOf(entry.id),
    );
    const siblings = pages
      .filter((page) => groupOf(page.id) === groupOf(entry.id))
      .toSorted((a, b) => order(a) - order(b));
    const number = String(siblings.indexOf(entry) + 1).padStart(2, "0");
    return {
      params: { slug: entry.id },
      props: {
        group: group ? `${group.label} ${number}` : undefined,
        title: entry.data.title,
        description: entry.data.description,
      },
    };
  });
}) satisfies GetStaticPaths;

interface Props {
  readonly group: string | undefined;
  readonly title: string;
  readonly description: string | undefined;
}

export const GET = async ({ props }: { readonly props: Props }) =>
  new Response(await socialCard({ ...props, site: SITE }), {
    headers: { "Content-Type": "image/png" },
  });
