import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/confirm-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) => {
  if (state.status !== "placed") {
    throw new DomainError(
      `Only placed orders can be confirmed; this one is ${state.status ?? "new"}`,
    );
  }
  return [events.orderConfirmed()];
};
