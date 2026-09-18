import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.OrderPlaced],
  completedBy: [events.OrderPaid, events.OrderCancelled],
  timeout: "48h",
});

export const state = ({ z }: Process.StateArgs) => z.object({ reminders: z.int().default(0) });
