import type { Process } from "./+types/index";

export interface Collaborators {
  readonly reminders: { remind: (orderId: string) => Promise<void> };
}

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.OrderPlaced],
  completedBy: [events.OrderPaid, events.OrderCancelled],
  timeout: "48h",
});

export const state = ({ z }: Process.StateArgs) => z.object({ reminders: z.int().default(0) });
