import type { Event } from "./+types/points-redeemed";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ points: z.int().positive() });

export const evolve = ({ state, event }: Event.EvolveArgs) => ({
  points: state.points - event.payload.points,
});
