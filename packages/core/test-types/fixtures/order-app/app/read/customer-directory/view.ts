import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey(),
  email: f.string().optional(),
});
