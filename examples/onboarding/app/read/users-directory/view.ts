import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  userId: f.string().primaryKey(),
  email: f.string().index(),
  name: f.string(),
  status: f.string().index(),
  registeredAt: f.date(),
});
