import type { Collaborators } from "./index.ts";

export default {
  send: async ({ to, name }) => {
    console.log(`[email] welcome ${name} <${to}>`);
  },
} satisfies Collaborators["emailSender"];
