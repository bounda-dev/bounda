export const SITE = "https://docs.bounda.dev";

export const REPOSITORY = "https://github.com/bounda-dev/bounda";

export const DESCRIPTION = "Event sourcing and CQRS for TypeScript without the ceremony.";

// What a page hands to a chat; `{url}` becomes the page's address.
export const PROMPT = "Read {url}, a page of the Bounda docs, so I can ask about it.";

// Where the docs start. `/` has no page of its own (bounda.dev says what Bounda is), so it
// forwards here and the wordmark links here.
export const START = "/getting-started/";

const socialImageAlt =
  "The Bounda symbol as a machined monolith whose foot becomes the global stream, beside the headline: Event sourcing without the ceremony.";

export interface HeadTag {
  readonly tag: "meta";
  readonly attrs: { readonly property?: string; readonly name?: string; readonly content: string };
}

export interface SocialImageFunction {
  (url: string): readonly HeadTag[];
}

// The card shown when a docs page is shared; Starlight already sets the title, description and card type.
export const socialImage: SocialImageFunction = (url) => [
  { tag: "meta", attrs: { property: "og:image", content: url } },
  { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
  { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
  { tag: "meta", attrs: { property: "og:image:alt", content: socialImageAlt } },
  { tag: "meta", attrs: { name: "twitter:image", content: url } },
  { tag: "meta", attrs: { name: "twitter:image:alt", content: socialImageAlt } },
];
