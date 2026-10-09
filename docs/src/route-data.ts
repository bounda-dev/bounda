import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { SITE, START } from "./site.ts";

const CARD_TAGS = new Set(["og:image", "twitter:image"]);

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  route.siteTitleHref = START;
  // Each page shares its own card, drawn by src/pages/og/[...slug].png.ts.
  const card = `${SITE}/og/${route.id}.png`;
  for (const tag of route.head) {
    const key = tag.attrs?.property ?? tag.attrs?.name;
    if (typeof key === "string" && CARD_TAGS.has(key) && tag.attrs) tag.attrs.content = card;
    if (key === "og:image:alt" || key === "twitter:image:alt") {
      if (tag.attrs) tag.attrs.content = `${route.entry.data.title}, in the Bounda docs.`;
    }
  }
});
