import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey().notPersonal(),
  customerId: f.string().index().person(),
  status: f.string().index().notPersonal(),
  total: f.number(),
  itemCount: f.number(),
  placedAt: f.date(),
  paidAt: f.date().optional(),
  fulfilledAt: f.date().optional(),
  cancelledAt: f.date().optional(),
  confirmationSent: f.boolean(),
  reminderSent: f.boolean(),
  paymentId: f.string().optional().notPersonal(),
  paymentStatus: f.string().optional().notPersonal(),
});
