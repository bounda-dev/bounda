import { defineConfig } from "@bounda-dev/core/config";
import { memory } from "@bounda-dev/core/memory";

export default defineConfig({
  storage: memory({ location: "eu" }),
  runtime: { personalData: { retention: "2y" } },
});
