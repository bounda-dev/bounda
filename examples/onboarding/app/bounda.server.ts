import { mkdir } from "node:fs/promises";
import { boot } from "@bounda-dev/core/node";
import { createBounda } from "@bounda-dev/react-router";
import { registry } from "../.bounda/registry.ts";

export const { bounda, boundaMiddleware } = createBounda({
  boot: async () => {
    await mkdir("data", { recursive: true });
    return boot({ registry });
  },
});
