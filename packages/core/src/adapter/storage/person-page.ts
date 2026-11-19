import { codePointOrder } from "../sql/order.ts";
import type { ListByPersonArgs } from "./personal-key-store.ts";

export interface PageByKeyFunction {
  <Item>(
    items: readonly Item[],
    keyOf: (item: Item) => string,
    page: Pick<ListByPersonArgs, "after" | "limit">,
  ): Item[];
}

// Compared as the SQL stores compare their keys, by code point.
export const pageByKey: PageByKeyFunction = (items, keyOf, { after, limit }) => {
  const sorted = items
    .filter((item) => after === undefined || codePointOrder(keyOf(item), after) > 0)
    .sort((a, b) => codePointOrder(keyOf(a), keyOf(b)));
  return sorted.slice(0, limit);
};
