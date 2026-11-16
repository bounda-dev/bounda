import type { PersonalData } from "./+types/personal-data";

export const categories = {
  delivery: { basis: "contract", retention: "1y" },
} satisfies PersonalData.Categories;
