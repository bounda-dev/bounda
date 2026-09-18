import type { Command } from "./+types/register-customer";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ customerId: z.uuid(), email: z.email() });

export const handler = ({ command, events }: Command.HandlerArgs) => [
  events.customerRegistered({ email: command.payload.email }),
];
