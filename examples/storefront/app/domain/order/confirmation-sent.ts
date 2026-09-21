import type { Event } from "./+types/confirmation-sent";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, confirmationSent: true });
