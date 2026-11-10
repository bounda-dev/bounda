import { writeSync } from "node:fs";
import { beforeEach } from "vitest";

// With BOUNDA_TEST_TRACE set, names each test as it starts, straight on the process's stderr: a
// test whose process dies in native code leaves its name behind, which the reporters, fed by the
// worker over RPC, lose with it.
if (process.env.BOUNDA_TEST_TRACE) {
  beforeEach(({ task }) => {
    writeSync(2, `[test] ${task.file.name} > ${task.name}\n`);
  });
}
