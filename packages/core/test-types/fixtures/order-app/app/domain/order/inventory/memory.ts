import type { Implementation } from "./+types/memory";

export const reserved: string[] = [];

export default {
  async reserve(skus: readonly string[]): Promise<void> {
    reserved.push(...skus);
  },
} satisfies Implementation.Contract;
