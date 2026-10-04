import { asInstant } from "@bounda-dev/core";
import type { Process } from "./+types/on-order-paid";

export const handler = ({ event }: Process.HandlerArgs) => ({
  paidAt: asInstant(event.timestamp),
});
