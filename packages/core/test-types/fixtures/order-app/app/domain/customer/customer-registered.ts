import type { Event } from "./+types/customer-registered";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ email: z.email() });

export const evolve = ({ state, event }: Event.EvolveArgs) => ({
  ...state,
  email: event.payload.email,
  active: true,
});
