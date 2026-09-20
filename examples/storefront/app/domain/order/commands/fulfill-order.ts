import { DomainError } from "@bounda-dev/core";
import type { Command } from "./+types/fulfill-order";

export const payload = ({ z }: Command.PayloadArgs) => z.object({ orderId: z.uuid() });

export const handler = ({ state, events }: Command.HandlerArgs) => {
  if (state.status !== "confirmed") {
    throw new DomainError(
      `Only confirmed orders can be fulfilled; this one is ${state.status ?? "new"}`,
    );
  }
  return [events.orderFulfilled()];
};
