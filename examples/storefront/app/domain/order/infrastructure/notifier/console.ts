import type { Notifier } from "../../notifier.ts";

export default (async ({ orderId, customerId, total, idempotencyKey }) => {
  console.log(
    `[notifier] confirmation for order ${orderId} sent to ${customerId} (${total}), key ${idempotencyKey}`,
  );
}) satisfies Notifier;
