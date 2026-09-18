import type { Event } from "./+types/customer-registered";

export const payload = ({ z }: Event.PayloadArgs) => z.object({ email: z.email() });

export const apply = ({ state, event }: Event.ApplyArgs) => ({
  ...state,
  email: event.payload.email,
  active: true,
});
