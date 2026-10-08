export interface Inventory {
  reserve(skus: readonly string[]): Promise<void>;
}
