import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  orderId: f.string().primaryKey().notPersonal(),
  customerId: f.string().index().person(),
  status: f.string().notPersonal(),
  total: f.number(),
});
