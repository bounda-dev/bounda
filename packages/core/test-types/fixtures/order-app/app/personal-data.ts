import type { PersonalData } from "./+types/personal-data";

export const categories = {
  delivery: { basis: "contract", retention: "30d" },
  invoices: { basis: "legal-obligation", retention: "2192d" },
} satisfies PersonalData.Categories;
