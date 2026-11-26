// Vitest's default timeout guards against a hang, not a slow test, and the whole suite's load
// breaks it: tests that take under a second alone, the storage contracts in workerd and the
// whole-app tests in `core` and `react-router`, took over 5 s beside the rest of a CI run, more so
// under coverage or Stryker, and failed it. A hang still fails, later.
export const TEST_TIMEOUT_MS = 30_000;
