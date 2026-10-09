import { createFixedClock } from "@bounda-dev/core";

/**
 * The clock the test object runs on, moved by the tests.
 */
export const clock = createFixedClock();
