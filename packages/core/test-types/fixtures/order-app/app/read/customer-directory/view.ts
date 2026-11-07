import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey().person(),
  email: f.string().optional().personal(),
});
