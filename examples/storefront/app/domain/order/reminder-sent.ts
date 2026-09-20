import type { Event } from "./+types/reminder-sent";

export const apply = ({ state }: Event.ApplyArgs) => ({ ...state, reminderSent: true });
