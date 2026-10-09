import { defineConfig } from "@bounda-dev/core/config";
import { postgresql } from "@bounda-dev/postgresql";
import { sqlite } from "@bounda-dev/sqlite";

const url = process.env.DATABASE_URL;

export default defineConfig({
  storage: url === undefined ? sqlite({ path: "./data/onboarding.db" }) : postgresql({ url }),
  ports: {
    user: { emailSender: process.env.EMAIL_SENDER === "memory" ? "memory" : "console" },
  },
});
