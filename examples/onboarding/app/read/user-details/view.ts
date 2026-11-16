import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  userId: f.string().primaryKey().person(),
  email: f.string().personal({ category: "account" }),
  name: f.string().personal({ category: "account" }),
  status: f.string().notPersonal(),
  registeredAt: f.date(),
  registeredBy: f.string().optional().notPersonal(),
  welcomeEmailSentAt: f.date().optional().notPersonal(),
  activatedAt: f.date().optional(),
  activatedBy: f.string().optional().notPersonal(),
  expiredAt: f.date().optional(),
});
