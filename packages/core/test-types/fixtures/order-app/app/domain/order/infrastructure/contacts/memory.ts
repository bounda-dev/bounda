import type { Contact, Contacts } from "../../contacts.ts";

export const contacts: Contact[] = [];

export default {
  async find(customerId: string): Promise<Contact | null> {
    return contacts.find((contact) => contact.customerId === customerId) ?? null;
  },
  async household(customerId: string): Promise<readonly Contact[]> {
    return contacts.filter((contact) => contact.customerId !== customerId);
  },
  async ping(): Promise<boolean> {
    return true;
  },
} satisfies Contacts;
