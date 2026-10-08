import type { Mailer } from "../../mailer.ts";

export const sent: string[] = [];

export default {
  async send(to: string, message: string): Promise<void> {
    sent.push(`${to}: ${message}`);
  },
} satisfies Mailer;
