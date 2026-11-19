import type { Adapter } from "@bounda-dev/core/adapter";
import { defineConfig } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

// A store whose subscriber failures and recipients cannot be read, as during an outage of theirs.
const base = memory();
const down = async (): Promise<never> => {
  throw new Error("the store is down");
};
const storage: Adapter = {
  ...base,
  createStorage: async () => {
    const ports = await base.createStorage();
    return {
      ...ports,
      subscriberFailures: { ...ports.subscriberFailures, list: down },
      recipients: { ...ports.recipients, declared: down },
    };
  },
};

export default defineConfig({ storage, runtime: { role: "all" } });
