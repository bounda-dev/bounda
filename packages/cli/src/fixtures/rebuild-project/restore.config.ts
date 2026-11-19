import { ConfigurationError } from "@bounda-dev/core";
import type { Adapter } from "@bounda-dev/core/adapter";
import { defineConfig } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

// A storage that restores in place: names in `globalThis.restoredFrom` every copy it was handed,
// and refuses one named `refused.db`.
const restoredFrom: string[] =
  (Reflect.get(globalThis, "restoredFrom") as string[] | undefined) ?? [];
Reflect.set(globalThis, "restoredFrom", restoredFrom);
const storage: Adapter = {
  ...memory(),
  restore: async ({ copy }) => {
    if (copy.endsWith("refused.db")) throw new ConfigurationError(`The copy at ${copy} is not one`);
    restoredFrom.push(copy);
  },
};

export const restoring = storage;

export default defineConfig({ storage, runtime: { role: "all" } });
