import type { PersonalData } from "./+types/personal-data";

export const categories = {
  account: {
    basis: "contract",
    retention: "2y",
    purposes: ["Run the member's account and onboard them"],
    sources: ["data-subject"],
  },
} satisfies PersonalData.Categories;

export const automatedDecisions = {} satisfies PersonalData.AutomatedDecisions;
