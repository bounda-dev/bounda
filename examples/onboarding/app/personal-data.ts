import type { PersonalData } from "./+types/personal-data";

export const categories = {
  account: { basis: "contract", retention: "2y" },
} satisfies PersonalData.Categories;
