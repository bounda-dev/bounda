import { defineConfig } from "../../../config/index.ts";
import { memory } from "../../../memory/index.ts";

export default defineConfig({
  storage: memory(),
  runtime: { role: (process.env.BOUNDA_ROLE as "web" | "worker" | "all" | undefined) ?? "all" },
});
