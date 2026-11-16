import type { PersonalData } from "./+types/personal-data";

export const categories = {
  delivery: {
    basis: "contract",
    retention: "1y",
    purposes: ["Deliver what the customer orders"],
    sources: ["data-subject"],
  },
} satisfies PersonalData.Categories;

export const automatedDecisions = {} satisfies PersonalData.AutomatedDecisions;
