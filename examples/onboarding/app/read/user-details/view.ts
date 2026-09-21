import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  userId: f.string().primaryKey(),
  email: f.string(),
  name: f.string(),
  status: f.string(),
  registeredAt: f.date(),
  welcomeEmailSentAt: f.date().optional(),
  activatedAt: f.date().optional(),
  expiredAt: f.date().optional(),
});
