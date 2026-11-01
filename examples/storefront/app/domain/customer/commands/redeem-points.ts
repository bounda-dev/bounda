import type { Command } from "./+types/redeem-points";

export const payload = ({ z }: Command.PayloadArgs) =>
  z.object({ customerId: z.string().min(1), points: z.int().positive() });

export const rejections = ({ state }: Command.RejectionsArgs) => ({
  NotEnoughPoints: `Only ${state.points} points to redeem`,
});

export const handler = ({ command, state, events, reject }: Command.HandlerArgs) => {
  if (command.payload.points > state.points) return reject("NotEnoughPoints");
  return [events.pointsRedeemed({ points: command.payload.points })];
};
