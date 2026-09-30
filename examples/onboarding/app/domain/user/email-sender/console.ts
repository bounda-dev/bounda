import type { Implementation } from "./+types/console";

export default {
  send: async ({ to, name }, idempotencyKey) => {
    console.log(`[email] welcome ${name} <${to}>, key ${idempotencyKey}`);
  },
} satisfies Implementation.Contract;
