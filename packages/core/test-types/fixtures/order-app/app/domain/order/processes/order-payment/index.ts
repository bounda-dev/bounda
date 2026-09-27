import type { Process } from "./+types/index";

export interface Collaborators {
  readonly reminders: { remind: (orderId: string) => Promise<void> };
}

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderPaid, events.order.OrderCancelled],
  timeout: "48h",
});

export const state = ({ z, deadline, instant }: Process.StateArgs) =>
  z.object({ reminders: z.int().default(0), nextReminder: deadline(), paidAt: instant() });

export const correlate: Process.Correlate = {
  customer: { CustomerRegistered: () => null },
};
