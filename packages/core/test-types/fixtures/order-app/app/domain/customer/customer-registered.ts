import type { Event } from "./+types/customer-registered";

export const payload = ({ z, personal }: Event.PayloadArgs) =>
  z.object({ email: personal(z.email()) });

export const evolve = ({ state, event }: Event.EvolveArgs) => ({
  ...state,
  email: event.payload.email,
  active: true,
});
