import type { Policy } from "./+types/audit-on-processing-restriction-lifted";

export const handler = ({ event, auditLog }: Policy.HandlerArgs) => {
  auditLog.record(`lifted ${event.payload.personId}`);
};
