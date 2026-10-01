import type { Implementation } from "./+types/memory";

export const sent: string[] = [];

export default {
  async send(to: string, message: string): Promise<void> {
    sent.push(`${to}: ${message}`);
  },
} satisfies Implementation.Contract;
