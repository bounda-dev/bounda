import { cloudflare } from "@bounda-dev/cloudflare";
import { defineConfig, masterKey } from "@bounda-dev/core/config";

export default defineConfig({
  storage: cloudflare(),
  runtime: {
    personalData: { keyWrapper: masterKey({ from: "BOUNDA_MASTER_KEY" }) },
  },
});
