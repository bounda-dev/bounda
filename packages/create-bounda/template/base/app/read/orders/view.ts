import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey().notPersonal(),
  customerId: f.string().index().person(),
  total: f.number(),
  placedAt: f.date(),
  deliveryNote: f.string().optional().personal({ category: "delivery" }),
});
