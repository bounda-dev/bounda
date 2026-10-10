import type { Event } from "./+types/reminder-sent";

export const evolve = ({ state }: Event.EvolveArgs) => ({ reminders: state.reminders + 1 });
