import { defineConfig, defineForgetLedger } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

const down = async (): Promise<never> => {
  throw new Error("ledger is down");
};

// A strict forget ledger that is down: the app does not start, and forgets nobody.
export default defineConfig({
  storage: memory(),
  runtime: {
    role: "all",
    personalData: {
      forgetLedger: {
        store: defineForgetLedger(() => ({ append: down, read: down })),
        strict: true,
      },
    },
  },
});
