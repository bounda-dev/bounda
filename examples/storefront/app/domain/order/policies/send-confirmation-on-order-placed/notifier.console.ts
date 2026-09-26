import type { Collaborators } from "./index.ts";

export default {
  send: async ({ orderId, customerId, total }, idempotencyKey) => {
    console.log(
      `[notifier] confirmation for order ${orderId} sent to ${customerId} (${total}), key ${idempotencyKey}`,
    );
  },
} satisfies Collaborators["notifier"];
