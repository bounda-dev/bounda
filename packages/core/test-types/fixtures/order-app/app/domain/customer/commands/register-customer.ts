import type { Command } from "./+types/register-customer";

export const payload = ({ z, personal, notPersonal }: Command.PayloadArgs) =>
  z.object({ customerId: notPersonal(z.uuid()), email: personal(z.email()) });

export const handler = ({ command, events }: Command.HandlerArgs) => [
  events.customerRegistered({ email: command.payload.email }),
];
