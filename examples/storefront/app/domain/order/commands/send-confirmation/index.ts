import type { Command } from "./+types/index";

export interface Confirmation {
  readonly orderId: string;
  readonly customerId: string;
  readonly total: number;
}

export type Collaborators = {
  notifier: { send: (confirmation: Confirmation) => Promise<void> };
};

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = async ({ command, state, events, notifier }: Command.HandlerArgs) => {
  if (state.status === undefined || state.confirmationSent !== false) return [];
  await notifier.send({
    orderId: command.aggregateId,
    customerId: state.customerId ?? "",
    total: state.total ?? 0,
  });
  return [events.confirmationSent()];
};
