import type { CreateImplementation } from "@bounda-dev/core";
import type { Inventory } from "../../inventory.ts";

export const create: CreateImplementation<Inventory> = ({ env }) => {
  const url = env.INVENTORY_URL ?? "http://localhost:8080";
  return {
    async reserve(skus) {
      await fetch(`${url}/reserve`, { method: "POST", body: JSON.stringify(skus) });
    },
  };
};
