import { defineConfig } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

// A tenants export that is not a list of tenant names.
export const tenants = [42];

export default defineConfig({
  storage: memory(),
  runtime: { personalData: { forgetLedger: { store: memory(), keepFor: "30d" } } },
});
