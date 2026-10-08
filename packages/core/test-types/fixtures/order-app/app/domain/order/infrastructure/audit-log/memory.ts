import type { AuditLog } from "../../audit-log.ts";

export const entries: string[] = [];

export default {
  record(entry: string): void {
    entries.push(entry);
  },
} satisfies AuditLog;
