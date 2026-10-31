import type { Policy } from "./+types/audit-on-personal-data-forgotten";

export const handler = ({ event, auditLog }: Policy.HandlerArgs) => {
  auditLog.record(`forgot ${event.payload.personId}`);
};
