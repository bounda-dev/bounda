import type { Collaborators, Confirmation } from "./index.ts";

/**
 * Every confirmation "sent" so far. Tests read it; nothing else should.
 */
export const sent: Confirmation[] = [];

export default {
  send: async (confirmation) => {
    sent.push(confirmation);
  },
} satisfies Collaborators["notifier"];
