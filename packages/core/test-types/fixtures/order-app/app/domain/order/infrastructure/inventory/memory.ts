import type { Inventory } from "../../inventory.ts";

export const reserved: string[] = [];

export default {
  async reserve(skus: readonly string[]): Promise<void> {
    reserved.push(...skus);
  },
} satisfies Inventory;
