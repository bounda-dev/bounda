import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  userId: f.string().primaryKey().person(),
  email: f.string().personal(),
  name: f.string().personal(),
  status: f.string(),
  registeredAt: f.date(),
  welcomeEmailSentAt: f.date().optional(),
  activatedAt: f.date().optional(),
  expiredAt: f.date().optional(),
});
