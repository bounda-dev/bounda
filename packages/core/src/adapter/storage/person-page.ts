import type { ListByPersonArgs } from "./personal-key-store.ts";

export interface PageByKeyFunction {
  <Item>(
    items: readonly Item[],
    keyOf: (item: Item) => string,
    page: Pick<ListByPersonArgs, "after" | "limit">,
  ): Item[];
}

// Compared as the SQL stores compare their keys, code unit by code unit.
export const pageByKey: PageByKeyFunction = (items, keyOf, { after, limit }) => {
  const sorted = items
    .filter((item) => after === undefined || keyOf(item) > after)
    .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1));
  return sorted.slice(0, limit);
};
