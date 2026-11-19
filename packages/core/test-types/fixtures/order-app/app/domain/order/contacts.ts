import type { Port } from "./+types/contacts";

export interface Contact {
  readonly customerId: string;
  readonly email: string;
}

export interface Contacts {
  find(customerId: string): Promise<Contact | null>;
  household(customerId: string): Promise<readonly Contact[]>;
  ping(): Promise<boolean>;
}

export const returnsPersonalData = {
  find: { persons: ({ result }) => result?.customerId, categories: ["delivery"] },
  household: {
    persons: ({ args: [customerId], result }) => [customerId, ...result.map((c) => c.customerId)],
    personsOnError: ({ args: [customerId] }) => customerId,
  },
} satisfies Port.ReturnsPersonalData;
