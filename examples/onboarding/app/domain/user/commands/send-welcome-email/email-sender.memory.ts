import type { Collaborators, WelcomeEmail } from "./index.ts";

/**
 * Every welcome email "sent" so far. Tests read it; nothing else should.
 */
export const sent: WelcomeEmail[] = [];

export default {
  send: async (email) => {
    sent.push(email);
  },
} satisfies Collaborators["emailSender"];
