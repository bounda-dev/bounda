import { APP_MODULE_ID } from "./app-module.ts";
import type { Bounda } from "./create-bounda.ts";

const missing = (): never => {
  throw new Error(
    `${APP_MODULE_ID} is served by the bounda() Vite plugin. Add it to vite.config.ts: ` +
      'import { bounda } from "@bounda-dev/react-router/vite"; plugins: [bounda(), reactRouter()]',
  );
};

export const provided: Bounda = missing();
