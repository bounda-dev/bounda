import type { View } from "./+types/view";

export const fields = ({ f }: View.FieldsArgs) => ({
  customerId: f.string().primaryKey().person(),
  email: f.string().optional().personal(),
  tier: f.json<"regular" | "vip">().optional(),
  newsletter: f.boolean().optional(),
});
