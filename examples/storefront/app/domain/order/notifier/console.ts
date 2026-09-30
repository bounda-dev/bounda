import type { Implementation } from "./+types/console";

export default (async ({ orderId, customerId, total }, idempotencyKey) => {
  console.log(
    `[notifier] confirmation for order ${orderId} sent to ${customerId} (${total}), key ${idempotencyKey}`,
  );
}) satisfies Implementation.Contract;
