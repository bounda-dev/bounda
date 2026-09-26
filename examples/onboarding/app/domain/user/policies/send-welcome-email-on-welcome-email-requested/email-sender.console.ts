import type { Collaborators } from "./index.ts";

export default {
  send: async ({ to, name }, idempotencyKey) => {
    console.log(`[email] welcome ${name} <${to}>, key ${idempotencyKey}`);
  },
} satisfies Collaborators["emailSender"];
