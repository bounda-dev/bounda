import type { Policy } from "./+types/index";

export interface Confirmation {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
}

export type Collaborators = {
  notifier: { send: (confirmation: Confirmation, idempotencyKey: string) => Promise<void> };
};

export const handler = async ({
  event,
  commands,
  notifier,
  idempotencyKey,
}: Policy.HandlerArgs) => {
  await notifier.send(
    {
      orderId: event.aggregateId,
      customerId: event.payload.customerId,
      total: event.payload.total,
    },
    idempotencyKey,
  );
  await commands.recordConfirmationSent({ orderId: event.aggregateId });
};
