import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  userId: f.string().primaryKey().person(),
  email: f.string().index().personal({ category: "account" }),
  name: f.string().personal({ category: "account" }),
  status: f.string().index().notPersonal(),
  registeredAt: f.date(),
});
