import type { PersonalData } from "./+types/personal-data";

export const categories = {
  delivery: { basis: "contract", retention: "30d" },
  invoices: { basis: "legal-obligation", retention: "6y" },
} satisfies PersonalData.Categories;
