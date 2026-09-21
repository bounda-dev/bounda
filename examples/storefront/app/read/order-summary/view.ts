import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey(),
  customerId: f.string().index(),
  status: f.string().index(),
  total: f.number(),
  itemCount: f.number(),
  placedAt: f.date(),
  confirmedAt: f.date().optional(),
  fulfilledAt: f.date().optional(),
  cancelledAt: f.date().optional(),
  confirmationSent: f.boolean(),
  reminderSent: f.boolean(),
});
