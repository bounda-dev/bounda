import { defineRouteMiddleware } from "@astrojs/starlight/route-data";
import { START } from "./site.ts";

export const onRequest = defineRouteMiddleware((context) => {
  context.locals.starlightRoute.siteTitleHref = START;
});
