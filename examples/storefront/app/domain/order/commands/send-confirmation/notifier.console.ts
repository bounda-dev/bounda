import type { Collaborators } from "./index.ts";

export default {
  send: async ({ orderId, customerId, total }) => {
    console.log(`[notifier] confirmation for order ${orderId} sent to ${customerId} (${total})`);
  },
} satisfies Collaborators["notifier"];
