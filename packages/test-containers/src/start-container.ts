import { getContainerRuntimeClient } from "testcontainers";

export interface StartContainerFunction {
  <Started>(start: () => Promise<Started>): Promise<Started | null>;
}

// The CI variable as Vitest reads it: on unless unset, "" or "false".
const inCi = (): boolean => {
  const ci = process.env.CI;
  return ci !== undefined && ci !== "" && ci !== "false";
};

/**
 * Starts a container a test suite runs on, or resolves `null` when Docker is not running outside
 * CI, so the suite can skip itself.
 *
 * Docker is not running when Testcontainers finds no container runtime that answers. That is the
 * only failure that skips: in CI (`CI` set) it rejects too, since a skipped suite there would pass
 * without running, and any failure to start the container itself, such as a pull refused by a
 * rate limit, rejects with its own error wherever it happens.
 */
export const startContainer: StartContainerFunction = async (start) => {
  try {
    await getContainerRuntimeClient();
  } catch (error) {
    if (inCi()) {
      throw new Error("Docker is not running, and in CI every suite that needs it must run", {
        cause: error,
      });
    }
    return null;
  }
  return start();
};
