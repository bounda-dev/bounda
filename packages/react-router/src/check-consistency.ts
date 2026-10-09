import { ConfigurationError, type Consistency } from "@bounda-dev/core";

export interface CheckConsistencyFunction {
  (consistency: Consistency): void;
}

// Config files and the Vite plugin's options are often not type-checked.
export const checkConsistency: CheckConsistencyFunction = (consistency) => {
  if (consistency !== "read-your-writes" && consistency !== "eventual") {
    throw new ConfigurationError(
      `consistency must be "read-your-writes" or "eventual", got ${JSON.stringify(consistency)}`,
    );
  }
};
