import type { Command } from "./+types/earn-points";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ customerId: z.string().min(1), orderId: z.uuid(), points: z.int().nonnegative() });

export const handler = ({ command, events }: Command.HandlerArgs) => {
  const { orderId, points } = command.payload;
  return points === 0 ? [] : [events.pointsEarned({ orderId, points })];
};
