import { defineConfig } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";

const url = process.env.DATABASE_URL;
if (url === undefined) throw new Error("Set DATABASE_URL, see .env.example");

export default defineConfig({
  storage: postgresql({ url }),
});
