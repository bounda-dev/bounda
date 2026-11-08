import type { Process } from "./+types/index";

export const config = ({ events }: Process.ConfigArgs) => ({
  startedBy: [events.order.OrderPlaced],
  completedBy: [events.order.OrderPaid, events.order.OrderCancelled],
  timeout: "48h",
});

export const state = ({ z, deadline, instant, personal, person }: Process.StateArgs) =>
  z.object({
    reminders: z.int().default(0),
    nextReminder: deadline(),
    paidAt: instant(),
    customerId: person(z.string()).nullable().default(null),
    contact: personal(z.email()).nullable().default(null),
  });

export const correlate = ({ from }: Process.CorrelateArgs) => [
  from.customer.CustomerRegistered(() => null),
];
