import type { Process } from "./+types/on-welcome-email-sent";

export const handler = ({ state }: Process.HandlerArgs) => ({ ...state, welcomeEmailSent: true });
