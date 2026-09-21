import { postgresql } from "@bounda-dev/adapter-postgresql";
import { defineConfig } from "@bounda-dev/core/config";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("Set DATABASE_URL, see .env.example");

export default defineConfig({
  storage: postgresql({ url }),
});
