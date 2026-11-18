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
  dietary: {
    basis: "consent",
    retention: "1y",
    purposes: ["Leave out of each order what the customer cannot eat"],
    sources: ["data-subject"],
    special: { kinds: ["health"], condition: "explicit-consent" },
  },
} satisfies PersonalData.Categories;

export const automatedDecisions = {
  substitution: {
    categories: ["dietary", "delivery"],
    logic: "A product the customer cannot eat is swapped for the closest one they can",
    significance: "What the customer receives",
    consequences: "An order with other products than those chosen",
    profiling: false,
    ground: "explicit-consent",
    measures: "The customer sees each swap before the order ships and can refuse it",
  },
} satisfies PersonalData.AutomatedDecisions;
