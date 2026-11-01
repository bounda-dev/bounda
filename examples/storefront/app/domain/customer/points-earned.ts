import type { Event } from "./+types/points-earned";

export const payload = ({ z }: Event.PayloadArgs) =>
  z.object({ orderId: z.string(), points: z.int().positive() });

export const evolve = ({ state, event }: Event.EvolveArgs) => ({
  points: state.points + event.payload.points,
});
