import { DurableObject } from "cloudflare:workers";

/**
 * An empty Durable Object: the tests reach its storage through `runInDurableObject`.
 */
export class TestStore extends DurableObject {}

export default {
  fetch: () => new Response("bounda adapter-cloudflare test worker"),
};
