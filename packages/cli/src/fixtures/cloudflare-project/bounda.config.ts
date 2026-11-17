import { cloudflare } from "@bounda-dev/cloudflare";
import { defineConfig } from "@bounda-dev/core/config";

export default defineConfig({
  storage: cloudflare({ jurisdiction: "eu" }),
  runtime: { personalData: { retention: "2y" } },
});
