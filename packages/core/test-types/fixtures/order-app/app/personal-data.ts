import type { PersonalData } from "./+types/personal-data";

export const categories = {
  delivery: {
    basis: "contract",
    retention: "30d",
    purposes: ["Deliver the orders the customer places"],
    sources: ["data-subject"],
  },
  invoices: {
    basis: "legal-obligation",
    retention: "6y",
    purposes: ["Keep the invoices tax law requires"],
    sources: ["data-subject", "derived"],
  },
} satisfies PersonalData.Categories;

export const automatedDecisions = {} satisfies PersonalData.AutomatedDecisions;
