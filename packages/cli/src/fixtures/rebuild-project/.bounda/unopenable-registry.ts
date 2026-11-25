import type { Registry } from "@bounda-dev/core";
import { registry as failing } from "./failing-registry.ts";

// The failing registry with an access log that refuses every record while
// BOUNDA_TEST_ACCESS_LOG_DOWN is set: the status is read, the failures' text is not handed out.
export const registry = {
  ...failing,
  audit: {
    onPersonalDataAccess: async () => {
      if (process.env.BOUNDA_TEST_ACCESS_LOG_DOWN === "1") {
        throw new Error("the access log is down");
      }
    },
    onHostRejection: () => {},
  },
} as const satisfies Registry;
