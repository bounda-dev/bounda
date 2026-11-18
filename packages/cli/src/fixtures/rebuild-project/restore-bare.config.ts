import { defineConfig } from "@bounda-dev/core/config";
import { restoring } from "./restore.config.ts";

// The storage that restores in place, and nothing else configured.
export default defineConfig({ storage: restoring });
