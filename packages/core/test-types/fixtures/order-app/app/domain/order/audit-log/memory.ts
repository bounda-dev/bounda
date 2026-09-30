import type { Implementation } from "./+types/memory";

export const entries: string[] = [];

export default {
  record(entry: string): void {
    entries.push(entry);
  },
} satisfies Implementation.Contract;
