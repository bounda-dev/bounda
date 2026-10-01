import type { Implementation } from "./+types/http";

export const create: Implementation.Create = ({ env }) => {
  const url = env.INVENTORY_URL ?? "http://localhost:8080";
  return {
    async reserve(skus) {
      await fetch(`${url}/reserve`, { method: "POST", body: JSON.stringify(skus) });
    },
  };
};
